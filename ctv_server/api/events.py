import asyncio
from collections import deque
from copy import deepcopy
import json
import threading
import time
import uuid
from ctv_server.lifecycle import stopping
from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse
from ctv_server.auth import current_user

router = APIRouter(prefix="/api/events", tags=["events"])

# Producers run in scan worker threads. Both the history and listener registry
# are protected; asyncio queues must only be touched on their owning loop.
_listeners: list[tuple[asyncio.AbstractEventLoop, asyncio.Queue]] = []
_lock = threading.Lock()
_history = deque(maxlen=1024)
_sequence = 0
_epoch = uuid.uuid4().hex
_POLL_BYTES = 256 * 1024


def _sanitize(value):
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            if key in {"path", "source_path", "thumbnail_path", "hash", "metadata"}:
                continue
            if key == "error" and item:
                result[key] = "Source unavailable"
            else:
                result[key] = _sanitize(item)
        return result
    if isinstance(value, list):
        return [_sanitize(item) for item in value]
    return value


def emit(event_type: str, data: dict):
    """Publish once to bounded history and deliver safely to SSE listeners."""
    global _sequence
    payload = deepcopy(data)
    with _lock:
        _sequence += 1
        _history.append((_sequence, event_type, payload))
        for loop, queue in _listeners:
            try:
                loop.call_soon_threadsafe(_enqueue, queue, event_type, payload)
            except RuntimeError:
                pass  # The listener's event loop has already closed.


def _enqueue(queue, event_type, data):
    try:
        queue.put_nowait((event_type, data))
    except asyncio.QueueFull:
        pass


@router.get("/poll")
def poll_events(request: Request, cursor: str | None = Query(default=None, max_length=128)):
    """Finite responses for Ingress, with replay and explicit history gaps."""
    user = current_user(request)
    with _lock:
        latest = _sequence
        history = list(_history)
    after = latest
    reset = False
    if cursor is not None:
        try:
            epoch, offset = cursor.split(":", 1)
            after = int(offset)
            oldest = history[0][0] if history else latest + 1
            reset = epoch != _epoch or after < oldest - 1 or after > latest
        except ValueError:
            reset = True
        if reset:
            after = latest
    result = []
    size = 0
    for sequence, event_type, data in history:
        if sequence <= after:
            continue
        item = {"type": event_type, "data": data if user.is_admin else _sanitize(data)}
        item_size = len(json.dumps(item, ensure_ascii=False).encode("utf-8"))
        if item_size > _POLL_BYTES:
            # A full refresh is safer than replaying an incomplete payload.
            result = []
            after = latest
            reset = True
            break
        if len(result) >= 128 or size + item_size > _POLL_BYTES:
            break
        result.append(item)
        size += item_size
        after = sequence
    return JSONResponse({"cursor": f"{_epoch}:{after}", "events": result,
                         "reset": reset, "more": after < latest},
                        headers={"Cache-Control": "no-store"})


async def _event_stream(request: Request):
    q: asyncio.Queue = asyncio.Queue(maxsize=256)
    user = current_user(request)
    listener = (asyncio.get_running_loop(), q)
    with _lock:
        _listeners.append(listener)
    try:
        # Evento iniziale di connessione
        yield "event: connected\ndata: {}\n\n"
        heartbeat = time.monotonic()
        while not stopping.is_set():
            disconnected = await request.is_disconnected()
            if disconnected:
                break
            try:
                event_type, data = await asyncio.wait_for(q.get(), timeout=1.0)
                payload = data if user.is_admin else _sanitize(data)
                yield f"event: {event_type}\ndata: {json.dumps(payload)}\n\n"
            except asyncio.TimeoutError:
                if time.monotonic() - heartbeat >= 15:
                    heartbeat = time.monotonic()
                    yield ": keepalive\n\n"
    finally:
        with _lock:
            _listeners.remove(listener)


@router.get("")
async def events_stream(request: Request):
    """SSE endpoint per eventi realtime."""
    return StreamingResponse(
        _event_stream(request),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
