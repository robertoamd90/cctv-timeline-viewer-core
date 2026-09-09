import asyncio
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx

from ctv_server import db, playback, streaming
from ctv_server.main import app


PROFILE = {"name": "fast", "scale_percent": 30, "fps": 8, "bitrate_kbps": 450}


class PlaybackAdmissionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_db = db.DB_PATH
        db.DB_PATH = str(Path(self.tmp.name) / "test.db")
        db.init_db()
        playback.invalidate_settings()
        playback.history.clear()
        playback.leases.clear()
        streaming._hls_lock = asyncio.Lock()
        self.root_patch = patch.object(streaming, "_HLS_ROOT", Path(self.tmp.name) / "hls")
        self.root_patch.start()
        self.recording_patch = patch("ctv_server.main._stream_recording", return_value={"path": "fixture", "duration": 60})
        self.recording_patch.start()
        self.profiles_patch = patch("ctv_server.main.get_stream_profiles", return_value={"fast": PROFILE})
        self.profiles_patch.start()
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
        with db.write_db() as conn:
            conn.execute("UPDATE playback_settings SET max_transcoders = 1")
        playback.invalidate_settings()

    async def asyncTearDown(self):
        await self.client.aclose()
        await streaming.shutdown_hls_jobs()
        self.recording_patch.stop()
        self.profiles_patch.stop()
        self.root_patch.stop()
        db.close_db()
        db.DB_PATH = self.old_db
        playback.invalidate_settings()
        self.tmp.cleanup()

    async def admit(self, session_id, transport="mp4"):
        return await self.client.post("/api/playback-sessions", json={
            "session_id": session_id, "recording_id": 1, "profile": "fast", "transport": transport,
        })

    async def test_shared_capacity_rejects_before_video_response(self):
        first = "a" * 32
        with patch.object(streaming.asyncio, "create_subprocess_exec") as spawn:
            self.assertEqual((await self.admit(first, "hls")).status_code, 200)
            self.assertEqual((await self.admit("b" * 32)).status_code, 503)
            response = await self.client.get("/stream/1?profile=fast")
            self.assertEqual(response.status_code, 503)
            self.assertEqual(response.json()["detail"], "capacity")
            response = await self.client.get(f"/hls/{'c' * 32}/index.m3u8?recording_id=1&profile=fast")
            self.assertEqual(response.status_code, 503)
            spawn.assert_not_called()
        await self.client.delete(f"/api/playback-sessions/{first}")
        self.assertEqual((await self.admit("d" * 32)).status_code, 200)

    async def test_settings_persist_and_apply_to_new_admissions(self):
        response = await self.client.put("/api/admin/playback-settings", json={"max_transcoders": 2, "hls_temp_mb": 64})
        self.assertEqual(response.status_code, 200)
        playback.invalidate_settings()
        self.assertEqual(playback.settings(), {"max_transcoders": 2, "hls_temp_mb": 64})
        for char in "ab":
            self.assertEqual((await self.admit(char * 32)).status_code, 200)
        response = await self.client.put("/api/admin/playback-settings", json={"max_transcoders": 1, "hls_temp_mb": 64})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(playback.leases), 2, "lowering a limit must not terminate existing sessions")
        self.assertEqual((await self.admit("c" * 32)).status_code, 503)

    async def test_cancel_overtaking_admission_cannot_resurrect_source(self):
        session_id = "a" * 32
        await self.client.delete(f"/api/playback-sessions/{session_id}")
        self.assertEqual((await self.admit(session_id)).status_code, 409)
        self.assertFalse(playback.leases)

    async def test_idle_reservation_expires(self):
        with patch.object(playback, "RESERVATION_TIMEOUT", 0.01):
            await self.admit("a" * 32)
            await asyncio.sleep(0.03)
        self.assertFalse(playback.leases)
        self.assertEqual((await self.admit("b" * 32)).status_code, 200)

    async def test_session_parameters_and_duplicate_consumers_are_rejected(self):
        session_id = "a" * 32
        await self.admit(session_id)
        changed = await self.client.get(f"/stream/1?profile=fast&start=5&session_id={session_id}")
        self.assertEqual(changed.status_code, 409)
        signature = streaming.stream_signature("fixture", PROFILE, 0, 1, "mp4")
        playback.claim(session_id, signature)
        duplicate = await self.client.get(f"/stream/1?profile=fast&session_id={session_id}")
        self.assertEqual(duplicate.status_code, 409)

    async def test_spawn_failure_releases_hls_and_mp4(self):
        with patch.object(streaming.asyncio, "create_subprocess_exec", side_effect=OSError("test failure")):
            with self.assertRaises(OSError):
                await streaming.ensure_hls_playlist("a" * 32, "fixture", PROFILE, 0, 1)
            self.assertFalse(playback.leases)
            stream = streaming.transcode_stream("fixture", PROFILE, 0, 1)
            with self.assertRaises(OSError):
                await anext(stream)
            self.assertFalse(playback.leases)

    async def test_disconnect_before_response_iteration_releases_admission(self):
        from ctv_server.main import PlaybackStreamingResponse
        lease = playback.claim("a" * 32, ())
        stream = streaming.transcode_stream("fixture", PROFILE, 0, 1, lease)
        response = PlaybackStreamingResponse(stream, lease)
        async def disconnected(*args, **kwargs):
            raise OSError("disconnected before headers")
        with patch("starlette.responses.StreamingResponse.__call__", side_effect=disconnected):
            with self.assertRaises(OSError):
                await response({}, None, None)
        self.assertFalse(playback.leases)

    async def test_hls_budget_invalidates_session_before_removing_files(self):
        class Process:
            returncode = None
            def terminate(self): self.returncode = -15
            async def wait(self): return self.returncode
        directory = Path(self.tmp.name) / "budget"
        directory.mkdir()
        (directory / "segment_00000.ts").write_bytes(b"x" * 4096)
        job_id = "a" * 32
        process = Process()
        streaming._hls_jobs[job_id] = streaming.HlsJob((), directory, directory / "ffmpeg.log", process, time.monotonic(), time.monotonic())
        with patch.object(playback, "settings", return_value={"hls_temp_mb": 0.001}):
            await asyncio.wait_for(streaming.enforce_hls_budget(), 2)
        self.assertEqual(process.returncode, -15)
        self.assertFalse(directory.exists())
        self.assertEqual(playback.session_status(job_id)["reason"], "storage_limit")

    async def test_history_is_bounded_and_does_not_expose_paths(self):
        for n in range(300):
            await playback.cancel(f"{n:032x}")
        self.assertEqual(len(playback.history), 256)
        self.assertNotIn("signature", playback.session_status(f"{299:032x}"))

    async def test_cancel_during_spawn_keeps_capacity_until_process_is_stopped(self):
        class Process:
            returncode = None
            stderr = asyncio.StreamReader()
            def terminate(self):
                self.returncode = -15
                self.stderr.feed_eof()
        lease = playback.claim("a" * 32, ())
        lease.spawning = True
        cancellation = asyncio.create_task(playback.cancel(lease.id))
        await asyncio.sleep(0)
        with self.assertRaises(playback.PlaybackUnavailable):
            playback.reserve("b" * 32, ())
        process = Process()
        with self.assertRaises(playback.PlaybackUnavailable):
            await playback.attach(lease, process)
        await cancellation
        self.assertEqual(process.returncode, -15)
        self.assertFalse(playback.leases)

    async def test_completed_process_releases_capacity_before_stream_is_closed(self):
        command = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
                   "-f", "lavfi", "-i", "color=size=32x32:rate=5", "-t", "1",
                   "-c:v", "libx264", "-preset", "ultrafast", "-movflags",
                   "frag_keyframe+empty_moov", "-f", "mp4", "pipe:1"]
        with patch.object(streaming, "build_transcode_command", return_value=command):
            stream = streaming.transcode_stream("fixture", PROFILE, 0, 1)
            try:
                await anext(stream)
                for _ in range(30):
                    if not playback.leases:
                        break
                    await asyncio.sleep(0.05)
                self.assertFalse(playback.leases)
                self.assertEqual((await self.admit("b" * 32)).status_code, 200)
            finally:
                await stream.aclose()


if __name__ == "__main__":
    unittest.main()
