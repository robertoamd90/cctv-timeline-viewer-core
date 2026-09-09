import json
import asyncio
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from ctv_server import db
from ctv_server.api.system import stream_profiles, update_stream_profiles
from ctv_server.auth import CurrentUser
from ctv_server.models import StreamProfileConfig, StreamProfilesUpdate
from ctv_server.streaming import (
    build_hls_command,
    build_transcode_command,
    cancel_hls_job,
    ensure_hls_playlist,
    hls_playlist_contents,
    hls_segment,
    initial_hls_segment_count,
    shutdown_hls_jobs,
)
from ctv_server import streaming, playback


class StreamProfileTests(unittest.TestCase):
    def setUp(self):
        self.original_db_path = db.DB_PATH
        self.tmp = tempfile.TemporaryDirectory()
        db.DB_PATH = os.path.join(self.tmp.name, "ctv.db")
        db.init_db()

    def tearDown(self):
        db.DB_PATH = self.original_db_path
        self.tmp.cleanup()

    def test_defaults_include_immutable_native_profile(self):
        profiles = stream_profiles()
        self.assertEqual(profiles["native"]["scale_percent"], 100)
        self.assertFalse(profiles["native"]["configurable"])
        self.assertEqual(profiles["balanced"]["scale_percent"], 50)
        self.assertEqual(profiles["fast"]["bitrate_kbps"], 450)

    def test_profile_reads_are_cached_per_database(self):
        with patch.object(streaming.db, "get_db", wraps=db.get_db) as get_db:
            first = stream_profiles()
            second = stream_profiles()
        self.assertEqual(first, second)
        self.assertEqual(get_db.call_count, 1)

    def test_admin_can_update_compressed_profiles(self):
        admin = CurrentUser("admin", "admin", "Admin", True, True)
        updated = update_stream_profiles(
            StreamProfilesUpdate(
                balanced=StreamProfileConfig(
                    scale_percent=60, fps=18, bitrate_kbps=1600,
                ),
                fast=StreamProfileConfig(
                    scale_percent=25, fps=6, bitrate_kbps=300,
                ),
            ),
            admin,
        )
        self.assertEqual(updated["balanced"]["scale_percent"], 60)
        self.assertEqual(updated["balanced"]["fps"], 18)
        self.assertEqual(updated["fast"]["bitrate_kbps"], 300)
        self.assertEqual(updated["native"]["scale_percent"], 100)


class TranscodeCommandTests(unittest.TestCase):
    def setUp(self):
        playback.history.clear()
        playback.leases.clear()
        self.settings_patch = patch.object(playback, "settings", return_value={"max_transcoders": 0, "hls_temp_mb": 256})
        self.settings_patch.start()
        self.addCleanup(self.settings_patch.stop)

    profile = {
        "name": "balanced",
        "scale_percent": 50,
        "fps": 10,
        "bitrate_kbps": 500,
    }

    def test_hls_initial_buffer_scales_with_playback_speed(self):
        self.assertEqual(initial_hls_segment_count(1), 1)
        self.assertEqual(initial_hls_segment_count(4), 2)
        self.assertEqual(initial_hls_segment_count(8), 4)
        self.assertEqual(initial_hls_segment_count(16), 4)

    def test_command_preserves_aspect_ratio_and_bakes_speed(self):
        command = build_transcode_command("/video/input.mp4", self.profile, 3.25, 16)
        video_filter = command[command.index("-vf") + 1]
        self.assertIn("setpts=(PTS-STARTPTS)/16", video_filter)
        self.assertIn("fps=10", video_filter)
        self.assertIn("scale=trunc(iw*0.5/2)*2:trunc(ih*0.5/2)*2", video_filter)
        self.assertEqual(command[command.index("-b:v") + 1], "500k")
        self.assertEqual(command[command.index("-ss") + 1], "3.250")
        self.assertNotIn("-skip_frame", command)
        self.assertNotIn("-readrate", command)
        self.assertEqual(command.count("-threads"), 2)
        self.assertTrue(all(
            command[index + 1] == "1"
            for index, value in enumerate(command) if value == "-threads"
        ))
        self.assertEqual(command[command.index("-filter_threads") + 1], "1")

    def test_hls_is_paced_slightly_ahead_of_timeline_consumption(self):
        with patch.object(streaming, "_HLS_READRATE_FACTOR", 1.5):
            command = build_hls_command("/video/input.mp4", self.profile, 0, 4, "/tmp/hls")
        self.assertEqual(command[command.index("-readrate") + 1], "6")
        self.assertLess(command.index("-readrate"), command.index("-i"))

    def test_high_speed_boundary_start_uses_keyframes_only(self):
        command = build_transcode_command("/video/input.mp4", self.profile, 0, 16)
        self.assertEqual(command[command.index("-skip_frame") + 1], "nokey")
        self.assertLess(command.index("-skip_frame"), command.index("-i"))

    def test_high_speed_hls_seek_does_not_delay_output_with_input_pacing(self):
        for speed in (8, 16):
            command = build_hls_command("/video/input.mp4", self.profile, 2, speed, "/tmp/hls")
            self.assertNotIn("-readrate", command)
            self.assertNotIn("-skip_frame", command, "offset seeks must preserve short recording tails")

    def test_moderate_speed_decodes_all_source_frames(self):
        command = build_transcode_command("/video/input.mp4", self.profile, 0, 4)
        self.assertNotIn("-skip_frame", command)

    def test_ffmpeg_output_has_scaled_dimensions_and_shorter_duration(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = os.path.join(tmp, "source.mp4")
            output = os.path.join(tmp, "output.mp4")
            subprocess.run(
                [
                    "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
                    "-f", "lavfi", "-i", "testsrc=size=320x240:rate=20",
                    "-t", "2", "-c:v", "mpeg4", source,
                ],
                check=True,
            )
            command = build_transcode_command(source, self.profile, 0, 2)
            result = subprocess.run(command, check=True, capture_output=True)
            with open(output, "wb") as handle:
                handle.write(result.stdout)
            probe = subprocess.run(
                [
                    "ffprobe", "-v", "error", "-show_entries",
                    "stream=width,height:format=duration", "-of", "json", output,
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            metadata = json.loads(probe.stdout)
            self.assertEqual(metadata["streams"][0]["width"], 160)
            self.assertEqual(metadata["streams"][0]["height"], 120)
            self.assertLess(float(metadata["format"]["duration"]), 1.2)
            self.assertIn(b"moof", result.stdout)

    def test_hls_output_is_segmented_for_native_mobile_playback(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = os.path.join(tmp, "source.mp4")
            output_dir = os.path.join(tmp, "hls")
            os.mkdir(output_dir)
            subprocess.run(
                [
                    "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
                    "-f", "lavfi", "-i", "testsrc=size=320x240:rate=20",
                    "-t", "2", "-c:v", "mpeg4", source,
                ],
                check=True,
            )
            command = build_hls_command(source, self.profile, 0, 2, output_dir)
            subprocess.run(command, check=True, capture_output=True)
            playlist_path = os.path.join(output_dir, "index.m3u8")
            with open(playlist_path, encoding="utf-8") as handle:
                playlist = handle.read()
            self.assertIn("#EXTM3U", playlist)
            self.assertIn("#EXT-X-PLAYLIST-TYPE:EVENT", playlist)
            self.assertIn("#EXT-X-ENDLIST", playlist)
            self.assertIn("segment_00000.ts", playlist)
            self.assertNotIn(output_dir, playlist)
            segment = os.path.join(output_dir, "segment_00000.ts")
            probe = subprocess.run(
                [
                    "ffprobe", "-v", "error", "-show_entries",
                    "stream=width,height:packet=pts_time", "-of", "json", segment,
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            metadata = json.loads(probe.stdout)
            self.assertEqual(metadata["streams"][0]["width"], 160)
            self.assertEqual(metadata["streams"][0]["height"], 120)
            self.assertAlmostEqual(
                float(metadata["packets"][0]["pts_time"]), 0, places=3,
            )

    def test_short_hls_tail_has_positive_target_duration(self):
        with tempfile.TemporaryDirectory() as tmp:
            playlist = Path(tmp) / "index.m3u8"
            original = "#EXTM3U\n#EXT-X-TARGETDURATION:0\n#EXTINF:0.125000,\nsegment_00000.ts\n#EXT-X-ENDLIST\n"
            playlist.write_text(original, encoding="utf-8")
            served = hls_playlist_contents(playlist).decode("utf-8")
            self.assertIn("#EXT-X-TARGETDURATION:1\n", served)
            self.assertIn("#EXTINF:0.125000,", served)
            self.assertEqual(playlist.read_text(encoding="utf-8"), original)

    def test_hls_session_returns_a_playable_event_playlist(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = os.path.join(tmp, "source.mp4")
            subprocess.run(
                [
                    "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
                    "-f", "lavfi", "-i", "testsrc=size=320x240:rate=20",
                    "-t", "3", "-c:v", "mpeg4", source,
                ],
                check=True,
            )

            async def scenario():
                playlist_path = await ensure_hls_playlist(
                    "0123456789abcdef0123456789abcdef",
                    source,
                    self.profile,
                    0,
                    1,
                )
                playlist = playlist_path.read_text(encoding="utf-8")
                self.assertIn("#EXT-X-PLAYLIST-TYPE:EVENT", playlist)
                segment_name = next(
                    line for line in playlist.splitlines() if line.endswith(".ts")
                )
                self.assertTrue(hls_segment(
                    "0123456789abcdef0123456789abcdef", segment_name,
                ).is_file())
                served_playlist = hls_playlist_contents(playlist_path).decode("utf-8")
                self.assertIn(
                    "#EXT-X-START:TIME-OFFSET=0,PRECISE=YES",
                    served_playlist,
                )
                await shutdown_hls_jobs()

            asyncio.run(scenario())

    def test_idle_progressive_transcode_is_terminated(self):
        class FakeProcess:
            returncode = None
            terminated = False

            def terminate(self):
                self.terminated = True
                self.returncode = -15

            def kill(self):
                self.returncode = -9

            async def wait(self):
                return self.returncode

        async def scenario():
            process = FakeProcess()
            last_delivery = [0.0]
            with patch.object(streaming, "_TRANSCODE_IDLE_TIMEOUT", 0.01):
                await streaming._stop_idle_transcode(process, last_delivery)
            self.assertTrue(process.terminated)

        asyncio.run(scenario())

    def test_abandoned_hls_transcode_is_terminated_while_still_running(self):
        class FakeProcess:
            returncode = None
            terminated = False

            def terminate(self):
                self.terminated = True
                self.returncode = -15

            def kill(self):
                self.returncode = -9

            async def wait(self):
                return self.returncode

        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                job_id = "fedcba9876543210fedcba9876543210"
                process = FakeProcess()
                job = streaming.HlsJob(
                    (), Path(tmp), Path(tmp) / "ffmpeg.log", process, 0.0, 0.0,
                )
                streaming._hls_jobs[job_id] = job
                with patch.object(streaming, "_HLS_ACTIVE_IDLE_TIMEOUT", 0.01):
                    await streaming._expire_hls_job(job_id)
                self.assertTrue(process.terminated)
                self.assertNotIn(job_id, streaming._hls_jobs)

        asyncio.run(scenario())

    def test_hls_job_can_be_cancelled_explicitly(self):
        class FakeProcess:
            returncode = None
            terminated = False

            def terminate(self):
                self.terminated = True
                self.returncode = -15

            def kill(self):
                self.returncode = -9

            async def wait(self):
                return self.returncode

        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                job_id = "abcdef0123456789abcdef0123456789"
                process = FakeProcess()
                streaming._hls_jobs[job_id] = streaming.HlsJob(
                    (), Path(tmp), Path(tmp) / "ffmpeg.log", process, 0.0, 0.0,
                )
                self.assertTrue(await cancel_hls_job(job_id))
                self.assertTrue(process.terminated)
                self.assertNotIn(job_id, streaming._hls_jobs)

        asyncio.run(scenario())


class ProgressiveLifecycleTests(unittest.TestCase):
    def setUp(self):
        playback.history.clear()
        playback.leases.clear()
        self.settings_patch = patch.object(playback, "settings", return_value={"max_transcoders": 1, "hls_temp_mb": 256})
        self.settings_patch.start()
        self.addCleanup(self.settings_patch.stop)

    def test_cancelled_hls_start_does_not_wait_for_start_timeout(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                job_id = "abcdef0123456789abcdef0123456789"
                profile = TranscodeCommandTests.profile
                signature = (
                    "unused", profile["name"], profile["scale_percent"],
                    profile["fps"], profile["bitrate_kbps"], 0, 1, "hls",
                )
                job = streaming.HlsJob(
                    signature, Path(tmp), Path(tmp) / "ffmpeg.log", None, 0, 0,
                    cancelled=True,
                )
                streaming._hls_jobs[job_id] = job
                try:
                    with self.assertRaisesRegex(ValueError, "cancelled"):
                        await asyncio.wait_for(
                            ensure_hls_playlist(job_id, "unused", profile, 0, 1), 1,
                        )
                finally:
                    streaming._hls_jobs.pop(job_id, None)
        asyncio.run(scenario())

    def test_error_output_is_drained_and_bounded(self):
        async def scenario():
            reader = asyncio.StreamReader()
            reader.feed_data(b"x" * 100000 + b"last diagnostic")
            reader.feed_eof()
            tail = bytearray()
            await streaming._read_error_tail(reader, tail)
            self.assertEqual(len(tail), 4096)
            self.assertTrue(tail.endswith(b"last diagnostic"))
        asyncio.run(scenario())

    def test_disconnect_stops_real_ffmpeg_and_releases_slot(self):
        async def scenario():
            command = [
                "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
                "-re", "-f", "lavfi", "-i", "testsrc=size=64x64:rate=10",
                "-c:v", "libx264", "-preset", "ultrafast", "-g", "10",
                "-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "pipe:1",
            ]
            with patch.object(streaming, "build_transcode_command", return_value=command):
                stream = streaming.transcode_stream("unused", TranscodeCommandTests.profile, 0, 1)
                try:
                    self.assertTrue(await asyncio.wait_for(anext(stream), 10))
                    processes = list(streaming._progressive_processes)
                    self.assertEqual(len(processes), 1)
                    self.assertEqual(len(playback.leases), 1)
                finally:
                    await asyncio.wait_for(stream.aclose(), 3)
                self.assertIsNotNone(processes[0].returncode)
                self.assertFalse(streaming._progressive_processes)
                self.assertFalse(playback.leases)
                await playback.shutdown()
        asyncio.run(scenario())

    def test_process_exit_race_is_harmless(self):
        class ExitingProcess:
            returncode = None

            def terminate(self):
                raise ProcessLookupError()

            async def wait(self):
                self.returncode = 0
                return 0

        process = ExitingProcess()
        asyncio.run(streaming._stop_process(process))
        self.assertEqual(process.returncode, 0)


if __name__ == "__main__":
    unittest.main()
