"""Non-queuing admission and lifecycle shared by MP4 and HLS.

All mutations run on the application event loop. Reservations count against
capacity before subprocess creation; finished processes release capacity even
when a browser still has buffered video to consume.
"""
import asyncio
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from functools import lru_cache

from ctv_server import db


class PlaybackUnavailable(RuntimeError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@lru_cache(maxsize=8)
def _settings(database_path):
    del database_path
    conn = db.get_db()
    try:
        row = conn.execute("SELECT max_transcoders, hls_temp_mb FROM playback_settings WHERE id = 1").fetchone()
        return dict(row)
    finally:
        conn.close()


def settings():
    return _settings(db.DB_PATH).copy()


def invalidate_settings():
    _settings.cache_clear()


@dataclass
class Lease:
    id: str
    signature: tuple
    created: float = field(default_factory=time.monotonic)
    process: asyncio.subprocess.Process | None = None
    claimed: bool = False
    spawning: bool = False
    spawned: asyncio.Event = field(default_factory=asyncio.Event)
    state: str = "reserved"
    reason: str = ""
    error_tail: bytearray = field(default_factory=bytearray)
    error_task: asyncio.Task | None = None
    reservation_task: asyncio.Task | None = None
    first_output_seconds: float | None = None
    bytes_sent: int = 0


leases: dict[str, Lease] = {}
history: OrderedDict = OrderedDict()
tasks: set = set()
counters = {"admitted": 0, "rejected": 0, "completed": 0, "cancelled": 0, "failed": 0, "peak_active": 0}
RESERVATION_TIMEOUT = 30


def status():
    return {
        **settings(),
        "active": sum(item.process is not None and item.process.returncode is None for item in leases.values()),
        "reserved": sum(item.process is None for item in leases.values()),
        "counters": counters.copy(),
    }


def remember(lease):
    history[lease.id] = {
        "state": lease.state, "reason": lease.reason,
        "first_output_seconds": lease.first_output_seconds,
        "bytes_sent": lease.bytes_sent,
    }
    history.move_to_end(lease.id)
    while len(history) > 256:
        history.popitem(last=False)


def session_status(session_id):
    lease = leases.get(session_id)
    if lease:
        return {"state": lease.state, "reason": lease.reason,
                "first_output_seconds": lease.first_output_seconds, "bytes_sent": lease.bytes_sent}
    return history.get(session_id, {"state": "expired", "reason": "session_expired"})


def finish(lease, state, reason=""):
    if leases.get(lease.id) is lease:
        leases.pop(lease.id)
        lease.state, lease.reason = state, reason
        counters[state] = counters.get(state, 0) + 1
        remember(lease)
        if lease.reservation_task and lease.reservation_task is not asyncio.current_task():
            lease.reservation_task.cancel()


def track(coro):
    task = asyncio.create_task(coro)
    tasks.add(task)
    task.add_done_callback(tasks.discard)
    return task


async def expire_reservation(lease):
    await asyncio.sleep(RESERVATION_TIMEOUT)
    if leases.get(lease.id) is lease and not lease.claimed:
        finish(lease, "cancelled", "session_expired")


def reserve(session_id, signature):
    existing = leases.get(session_id)
    if existing:
        if existing.signature != signature:
            raise PlaybackUnavailable("session_changed")
        return existing
    if session_id in history:
        raise PlaybackUnavailable("session_expired")
    limit = settings()["max_transcoders"]
    if limit and len(leases) >= limit:
        counters["rejected"] += 1
        raise PlaybackUnavailable("capacity")
    lease = Lease(session_id, signature)
    leases[session_id] = lease
    counters["admitted"] += 1
    lease.reservation_task = track(expire_reservation(lease))
    return lease


def claim(session_id, signature):
    lease = reserve(session_id, signature)
    if lease.claimed:
        raise PlaybackUnavailable("session_in_use")
    lease.claimed = True
    lease.state = "starting"
    return lease


async def drain_errors(reader, tail):
    while chunk := await reader.read(4096):
        tail.extend(chunk)
        del tail[:-4096]


async def stop_process(process):
    if process.returncode is not None:
        return
    try:
        process.terminate()
    except ProcessLookupError:
        return
    # Poll returncode rather than Process.wait(): unread stdout may keep wait()
    # blocked after process exit when a disconnected browser stopped consumption.
    deadline = time.monotonic() + 2
    while process.returncode is None and time.monotonic() < deadline:
        await asyncio.sleep(0.02)
    if process.returncode is None:
        try:
            process.kill()
        except ProcessLookupError:
            pass
        while process.returncode is None:
            await asyncio.sleep(0.01)


async def attach(lease, process):
    lease.process = process
    lease.spawned.set()
    lease.error_task = track(drain_errors(process.stderr, lease.error_tail))
    if leases.get(lease.id) is not lease or lease.reason:
        await stop_process(process)
        finish(lease, "cancelled", lease.reason or "session_expired")
        raise PlaybackUnavailable("session_expired")
    lease.state = "running"
    counters["peak_active"] = max(counters["peak_active"], sum(
        item.process is not None and item.process.returncode is None for item in leases.values()))
    track(watch_process(lease))


async def watch_process(lease):
    while lease.process.returncode is None:
        await asyncio.sleep(0.1)
    if lease.error_task:
        await lease.error_task
    if lease.reason:
        finish(lease, "cancelled", lease.reason)
    else:
        finish(lease, "completed" if lease.process.returncode == 0 else "failed",
               "" if lease.process.returncode == 0 else "encoding")


async def cancel(session_id, reason="cancelled"):
    lease = leases.get(session_id)
    if not lease:
        if session_id not in history or reason == "storage_limit":
            # A DELETE can overtake the corresponding admission request.
            remember(Lease(session_id, (), state="cancelled", reason=reason))
        return
    lease.reason = reason
    if lease.spawning and lease.process is None:
        # Keep the slot occupied until the in-flight spawn has been stopped.
        try:
            await asyncio.wait_for(lease.spawned.wait(), 3)
        except asyncio.TimeoutError:
            return
    if lease.process:
        await stop_process(lease.process)
    finish(lease, "cancelled", reason)


async def shutdown():
    await asyncio.gather(*(cancel(key) for key in list(leases)))
    pending = list(tasks)
    for task in pending:
        task.cancel()
    await asyncio.gather(*pending, return_exceptions=True)
    tasks.clear()
    history.clear()
