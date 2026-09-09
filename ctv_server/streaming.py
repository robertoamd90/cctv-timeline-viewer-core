import asyncio
import logging
import os
import re
import shutil
import tempfile
import time
import anyio
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import AsyncIterator, Optional

from ctv_server import db, playback
import uuid


PROFILE_NAMES = ("balanced", "fast")
_TRANSCODE_THREADS = max(1, int(os.environ.get("CTV_TRANSCODE_THREADS", "1")))
_HLS_READRATE_FACTOR = max(1.0, float(os.environ.get("CTV_HLS_READRATE_FACTOR", "1.5")))
_HLS_ACTIVE_IDLE_TIMEOUT = max(
    10.0, float(os.environ.get("CTV_HLS_ACTIVE_IDLE_TIMEOUT", "30")),
)
_HLS_ROOT = Path(os.environ.get(
    "CTV_HLS_ROOT", os.path.join(tempfile.gettempdir(), "ctv-hls"),
))
_HLS_TTL_SECONDS = max(30, int(os.environ.get("CTV_HLS_TTL_SECONDS", "300")))
_HLS_START_TIMEOUT = max(10, int(os.environ.get("CTV_HLS_START_TIMEOUT", "30")))
_TRANSCODE_IDLE_TIMEOUT = max(
    5.0, float(os.environ.get("CTV_TRANSCODE_IDLE_TIMEOUT", "30")),
)
_HLS_ID_PATTERN = re.compile(r"^[a-f0-9]{32}$")
_HLS_SEGMENT_PATTERN = re.compile(r"^segment_\d{5}\.ts$")


@dataclass
class HlsJob:
    signature: tuple
    directory: Path
    error_path: Path
    process: asyncio.subprocess.Process
    last_access: float
    started_at: float
    started_logged: bool = False
    cancelled: bool = False
    lease: object = None
    expiry_task: object = None


_hls_jobs: dict[str, HlsJob] = {}
_hls_lock = asyncio.Lock()
_hls_tasks: set[asyncio.Task] = set()
_progressive_processes: set[asyncio.subprocess.Process] = set()
_budget_task = None
log = logging.getLogger("ctv.streaming")


def _hls_failure_detail(job: HlsJob) -> str:
    if job.lease:
        return job.lease.error_tail.decode("utf-8", errors="replace")[-1000:]
    try:
        detail = job.error_path.read_text(
            encoding="utf-8", errors="replace",
        ).strip()
    except OSError:
        detail = ""
    return detail[-1000:] or f"ffmpeg exited {job.process.returncode}"


def initial_hls_segment_count(speed: float) -> int:
    if speed >= 8:
        return 4
    if speed >= 4:
        return 2
    return 1


@lru_cache(maxsize=8)
def _configured_profile_rows(database_path: str) -> tuple:
    del database_path
    conn = db.get_db()
    rows = conn.execute(
        """
        SELECT name, scale_percent, fps, bitrate_kbps
        FROM stream_profiles
        WHERE name IN ('balanced', 'fast')
        """
    ).fetchall()
    conn.close()
    return tuple(
        (row["name"], row["scale_percent"], row["fps"], row["bitrate_kbps"])
        for row in rows
    )


def invalidate_stream_profiles():
    _configured_profile_rows.cache_clear()


def get_stream_profiles() -> dict:
    configured = {
        name: {
            "name": name,
            "configurable": True,
            "scale_percent": scale_percent,
            "fps": fps,
            "bitrate_kbps": bitrate_kbps,
        }
        for name, scale_percent, fps, bitrate_kbps in _configured_profile_rows(db.DB_PATH)
    }
    return {
        "native": {
            "name": "native",
            "configurable": False,
            "scale_percent": 100,
            "fps": None,
            "bitrate_kbps": None,
        },
        **{name: configured[name] for name in PROFILE_NAMES},
    }


def _encoding_command(
    filepath: str,
    profile: dict,
    start_seconds: float,
    speed: float,
    pace_for_playback: bool = False,
) -> list[str]:
    scale = profile["scale_percent"] / 100
    fps = profile["fps"]
    bitrate = profile["bitrate_kbps"]
    preset = "ultrafast" if profile["name"] == "fast" else "veryfast"
    video_filter = (
        f"setpts=(PTS-STARTPTS)/{speed:g},"
        f"fps={fps},"
        f"scale=trunc(iw*{scale:g}/2)*2:trunc(ih*{scale:g}/2)*2:flags=fast_bilinear"
    )
    # Keyframe-only decoding is safe at a recording boundary. After an
    # arbitrary seek it can produce no frames when the clip ends before the
    # next source keyframe, so offset restarts use the normal decoder.
    decode_options = (
        ["-skip_frame", "nokey"]
        if speed >= 8 and start_seconds < 0.5
        else []
    )
    readrate_options = (
        ["-readrate", f"{speed * _HLS_READRATE_FACTOR:g}"]
        # At high encoded speeds, input readrate and timestamp compression can
        # delay even the first fragment after a seek. Keep normal-speed pacing;
        # high-speed jobs rely on admission, cancellation and the temp budget.
        if pace_for_playback and speed < 8 else []
    )
    return [
        "ffmpeg",
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-filter_threads",
        "1",
        "-ss",
        f"{start_seconds:.3f}",
        *readrate_options,
        *decode_options,
        "-threads",
        str(_TRANSCODE_THREADS),
        "-i",
        filepath,
        "-map",
        "0:v:0",
        "-an",
        "-sn",
        "-dn",
        "-vf",
        video_filter,
        "-c:v",
        "libx264",
        "-threads",
        str(_TRANSCODE_THREADS),
        "-preset",
        preset,
        "-tune",
        "zerolatency",
        "-pix_fmt",
        "yuv420p",
        "-b:v",
        f"{bitrate}k",
        "-maxrate",
        f"{bitrate}k",
        "-bufsize",
        f"{bitrate * 2}k",
        "-g",
        str(fps),
        "-keyint_min",
        str(fps),
        "-sc_threshold",
        "0",
        "-fps_mode",
        "cfr",
    ]


def build_transcode_command(
    filepath: str,
    profile: dict,
    start_seconds: float,
    speed: float,
) -> list[str]:
    return [
        *_encoding_command(filepath, profile, start_seconds, speed),
        "-movflags",
        "frag_keyframe+empty_moov+default_base_moof",
        "-flush_packets",
        "1",
        "-f",
        "mp4",
        "pipe:1",
    ]


def build_hls_command(
    filepath: str,
    profile: dict,
    start_seconds: float,
    speed: float,
    output_dir: str,
) -> list[str]:
    directory = Path(output_dir)
    return [
        *_encoding_command(
            filepath, profile, start_seconds, speed, pace_for_playback=True,
        ),
        "-hls_time",
        "1",
        "-hls_list_size",
        "0",
        "-hls_playlist_type",
        "event",
        "-hls_flags",
        "independent_segments+temp_file",
        "-hls_segment_filename",
        str(directory / "segment_%05d.ts"),
        "-muxdelay",
        "0",
        "-f",
        "hls",
        str(directory / "index.m3u8"),
    ]


async def _stop_process(process: asyncio.subprocess.Process):
    if process.returncode is not None:
        return
    try:
        process.terminate()
    except ProcessLookupError:
        await process.wait()
        return
    try:
        await asyncio.wait_for(process.wait(), timeout=2)
    except asyncio.TimeoutError:
        try:
            process.kill()
        except ProcessLookupError:
            pass
        await process.wait()


async def _stop_idle_transcode(
    process: asyncio.subprocess.Process,
    last_delivery: list[float],
):
    while process.returncode is None:
        remaining = _TRANSCODE_IDLE_TIMEOUT - (
            time.monotonic() - last_delivery[0]
        )
        if remaining > 0:
            await asyncio.sleep(min(remaining, 1.0))
            continue
        log.warning(
            "Stopping progressive transcode after %.1fs without client delivery",
            _TRANSCODE_IDLE_TIMEOUT,
        )
        await playback.stop_process(process)
        return


def stream_signature(filepath, profile, start_seconds, speed, transport):
    return (filepath, profile["name"], profile["scale_percent"], profile["fps"],
            profile["bitrate_kbps"], round(start_seconds, 3), speed, transport)


async def _expire_hls_job(job_id: str):
    job = _hls_jobs.get(job_id)
    if not job:
        return
    while job.process.returncode is None and not job.cancelled:
        idle_for = time.monotonic() - job.last_access
        if idle_for >= _HLS_ACTIVE_IDLE_TIMEOUT:
            job.cancelled = True
            await _stop_process(job.process)
            await playback.cancel(job_id, "idle")
            log.info(
                "Stopped abandoned HLS session %s after %.1fs without requests",
                job_id[:8], idle_for,
            )
            break
        await asyncio.sleep(min(1.0, _HLS_ACTIVE_IDLE_TIMEOUT - idle_for))
    await job.process.wait()
    if job.cancelled:
        async with _hls_lock:
            if _hls_jobs.get(job_id) is job:
                _hls_jobs.pop(job_id, None)
        shutil.rmtree(job.directory, ignore_errors=True)
        return
    if job.process.returncode:
        log.warning(
            "HLS session %s failed: %s",
            job_id[:8], _hls_failure_detail(job),
        )
        async with _hls_lock:
            if _hls_jobs.get(job_id) is job:
                _hls_jobs.pop(job_id, None)
        shutil.rmtree(job.directory, ignore_errors=True)
        return
    log.info(
        "HLS session %s completed in %.2fs with %d segments",
        job_id[:8],
        time.monotonic() - job.started_at,
        len(list(job.directory.glob("segment_*.ts"))),
    )
    while True:
        delay = _HLS_TTL_SECONDS - (time.monotonic() - job.last_access)
        if delay > 0:
            await asyncio.sleep(delay)
        async with _hls_lock:
            current = _hls_jobs.get(job_id)
            if current is not job:
                return
            if time.monotonic() - job.last_access < _HLS_TTL_SECONDS:
                continue
            _hls_jobs.pop(job_id, None)
        shutil.rmtree(job.directory, ignore_errors=True)
        return


async def cancel_hls_job(job_id: str, reason="cancelled") -> bool:
    if not _HLS_ID_PATTERN.fullmatch(job_id):
        return False
    async with _hls_lock:
        job = _hls_jobs.pop(job_id, None)
        if job:
            job.cancelled = True
    await playback.cancel(job_id, reason)
    if not job:
        return False
    if job.expiry_task and job.expiry_task is not asyncio.current_task():
        job.expiry_task.cancel()
        await asyncio.gather(job.expiry_task, return_exceptions=True)
    await _stop_process(job.process)
    shutil.rmtree(job.directory, ignore_errors=True)
    log.info("Cancelled HLS session %s", job_id[:8])
    return True


def _directory_bytes(directory):
    total = 0
    try:
        for path in directory.iterdir():
            try:
                total += path.stat().st_size
            except FileNotFoundError:
                pass
    except FileNotFoundError:
        pass
    return total


async def enforce_hls_budget():
    while _hls_jobs:
        jobs = list(_hls_jobs.items())
        sizes = await asyncio.gather(*(asyncio.to_thread(_directory_bytes, job.directory) for _, job in jobs))
        total = sum(sizes)
        limit = playback.settings()["hls_temp_mb"] * 1024 * 1024
        # Invalidate whole sessions before removing their files. Never prune a
        # segment from a playlist that remains valid. Prefer oldest completed
        # sessions, then the least recently accessed producer.
        for (job_id, job), size in sorted(zip(jobs, sizes), key=lambda item: (
                item[0][1].process.returncode is None, item[0][1].last_access)):
            if total <= limit:
                break
            if _hls_jobs.get(job_id) is job:
                log.warning("HLS session %s cancelled: temporary storage budget reached", job_id[:8])
                await cancel_hls_job(job_id, "storage_limit")
                total -= size
        await asyncio.sleep(0.5)


async def ensure_hls_playlist(
    job_id: str,
    filepath: str,
    profile: dict,
    start_seconds: float,
    speed: float,
) -> Path:
    global _budget_task
    if not _HLS_ID_PATTERN.fullmatch(job_id):
        raise ValueError("Invalid HLS session")
    signature = stream_signature(filepath, profile, start_seconds, speed, "hls")
    async with _hls_lock:
        job = _hls_jobs.get(job_id)
        if job and job.signature != signature:
            raise ValueError("HLS session parameters changed")
        if not job:
            lease = playback.claim(job_id, signature)
            directory = _HLS_ROOT / job_id
            started_at = time.monotonic()
            error_path = directory / "ffmpeg.log"
            try:
                directory.mkdir(parents=True, exist_ok=False)
                process = await asyncio.create_subprocess_exec(
                        *build_hls_command(
                            filepath, profile, start_seconds, speed, str(directory),
                        ),
                        stdout=asyncio.subprocess.DEVNULL,
                        stderr=asyncio.subprocess.PIPE,
                    )
                await playback.attach(lease, process)
            except BaseException:
                await playback.cancel(job_id, "start_failed")
                shutil.rmtree(directory, ignore_errors=True)
                raise
            job = HlsJob(
                signature, directory, error_path, process, started_at, started_at,
                lease=lease,
            )
            _hls_jobs[job_id] = job
            log.info(
                "Starting HLS session %s profile=%s speed=%gx offset=%.3fs "
                "threads=%d readrate=%s",
                job_id[:8], profile["name"], speed, start_seconds,
                _TRANSCODE_THREADS, f"{speed * _HLS_READRATE_FACTOR:g}x" if speed < 8 else "unpaced",
            )
            task = asyncio.create_task(_expire_hls_job(job_id))
            job.expiry_task = task
            _hls_tasks.add(task)
            task.add_done_callback(_hls_tasks.discard)
            if _budget_task is None or _budget_task.done():
                _budget_task = asyncio.create_task(enforce_hls_budget())
                _hls_tasks.add(_budget_task)
                _budget_task.add_done_callback(_hls_tasks.discard)
        else:
            job.last_access = time.monotonic()

    playlist = job.directory / "index.m3u8"
    required_segments = initial_hls_segment_count(speed)
    deadline = time.monotonic() + _HLS_START_TIMEOUT
    while time.monotonic() < deadline:
        if job.cancelled:
            raise ValueError("HLS session cancelled")
        if job.process.returncode not in (None, 0):
            log.warning(
                "HLS session %s failed: %s",
                job_id[:8], _hls_failure_detail(job),
            )
            raise RuntimeError("Unable to create HLS stream")
        if playlist.is_file():
            try:
                contents = playlist.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                contents = ""
            segment_names = [
                line.strip()
                for line in contents.splitlines()
                if _HLS_SEGMENT_PATTERN.fullmatch(line.strip())
            ]
            available_segments = sum(
                (job.directory / name).is_file() for name in segment_names
            )
            stream_complete = job.process.returncode == 0
            if available_segments and (
                available_segments >= required_segments or stream_complete
            ):
                job.last_access = time.monotonic()
                if not job.started_logged:
                    job.started_logged = True
                    lease = job.lease
                    if lease:
                        lease.first_output_seconds = time.monotonic() - job.started_at
                    log.info(
                        "HLS session %s playable in %.2fs with %d buffered segments",
                        job_id[:8],
                        time.monotonic() - job.started_at,
                        available_segments,
                    )
                return playlist
        await asyncio.sleep(0.05)
    await _stop_process(job.process)
    await playback.cancel(job_id, "start_timeout")
    log.warning(
        "HLS session %s did not produce a playable segment within %ss",
        job_id[:8], _HLS_START_TIMEOUT,
    )
    raise TimeoutError("Timed out while starting HLS stream")


def hls_playlist_contents(playlist: Path) -> bytes:
    contents = playlist.read_text(encoding="utf-8")
    # FFmpeg rounds sub-second tails to zero; native HLS rejects that playlist.
    contents = contents.replace("#EXT-X-TARGETDURATION:0\n", "#EXT-X-TARGETDURATION:1\n")
    start_tag = "#EXT-X-START:TIME-OFFSET=0,PRECISE=YES"
    if start_tag not in contents:
        contents = contents.replace(
            "#EXTM3U\n",
            f"#EXTM3U\n{start_tag}\n",
            1,
        )
    return contents.encode("utf-8")


def hls_segment(job_id: str, filename: str) -> Optional[Path]:
    if not _HLS_ID_PATTERN.fullmatch(job_id):
        return None
    if not _HLS_SEGMENT_PATTERN.fullmatch(filename):
        return None
    job = _hls_jobs.get(job_id)
    if not job:
        return None
    job.last_access = time.monotonic()
    path = job.directory / filename
    return path if path.is_file() else None


async def shutdown_hls_jobs():
    async with _hls_lock:
        jobs = list(_hls_jobs.values())
        _hls_jobs.clear()
    tasks = list(_hls_tasks)
    _hls_tasks.clear()
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    await asyncio.gather(
        *(_stop_process(job.process) for job in jobs),
        return_exceptions=True,
    )
    progressive = list(_progressive_processes)
    _progressive_processes.clear()
    await asyncio.gather(
        *(playback.stop_process(process) for process in progressive),
        return_exceptions=True,
    )
    shutil.rmtree(_HLS_ROOT, ignore_errors=True)
    await playback.shutdown()


async def transcode_stream(
    filepath: str, profile: dict, start_seconds: float, speed: float, lease=None,
) -> AsyncIterator[bytes]:
    if lease is None:
        lease = playback.claim(uuid.uuid4().hex, stream_signature(filepath, profile, start_seconds, speed, "mp4"))
    process = None
    idle_task = None
    started_at = time.monotonic()
    completed = False
    try:
        with anyio.CancelScope(shield=True):
            lease.spawning = True
            process = await asyncio.create_subprocess_exec(
                *build_transcode_command(filepath, profile, start_seconds, speed),
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            _progressive_processes.add(process)
            await playback.attach(lease, process)
        log.info("Starting MP4 session %s profile=%s speed=%gx offset=%.3fs",
                 lease.id[:8], profile["name"], speed, start_seconds)
        last_delivery = [time.monotonic()]
        idle_task = asyncio.create_task(_stop_idle_transcode(process, last_delivery))
        while True:
            chunk = await process.stdout.read(256 * 1024)
            if not chunk:
                break
            if not lease.bytes_sent:
                lease.first_output_seconds = time.monotonic() - started_at
                log.info("MP4 session %s first output in %.2fs", lease.id[:8], lease.first_output_seconds)
            lease.bytes_sent += len(chunk)
            last_delivery[0] = time.monotonic()
            yield chunk
        await process.wait()
        await lease.error_task
        completed = process.returncode == 0
        if not completed:
            log.warning("MP4 session %s failed (exit=%s): %s", lease.id[:8], process.returncode,
                        lease.error_tail.decode("utf-8", errors="replace").strip())
        playback.finish(lease, "completed" if completed else "failed", "" if completed else "encoding")
    except playback.PlaybackUnavailable:
        # A cancellation may arrive after HTTP headers but before attachment.
        # End the body; session status communicates why it was interrupted.
        return
    finally:
        with anyio.CancelScope(shield=True):
            lease.spawned.set()
            if idle_task:
                idle_task.cancel()
                await asyncio.gather(idle_task, return_exceptions=True)
            if process:
                await playback.stop_process(process)
                # No competing stdout consumer remains in this generator.
                while await process.stdout.read(65536):
                    pass
                if lease.error_task:
                    await asyncio.gather(lease.error_task, return_exceptions=True)
                _progressive_processes.discard(process)
            await playback.cancel(lease.id, "closed")
            if playback.history.get(lease.id, {}).get("state") == lease.state:
                playback.remember(lease)
            log.info("MP4 session %s stopped completed=%s bytes=%d elapsed=%.2fs",
                     lease.id[:8], completed, lease.bytes_sent, time.monotonic() - started_at)


_read_error_tail = playback.drain_errors
