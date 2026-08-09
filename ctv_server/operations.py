import threading
import time
from contextlib import contextmanager
from typing import Optional


class IndexBusyError(RuntimeError):
    pass


_guard = threading.Condition()
_active_index_jobs = 0
_maintenance_active = False
_index_generation = 0


def index_generation() -> int:
    with _guard:
        return _index_generation


def begin_index_job(expected_generation: Optional[int] = None) -> bool:
    global _active_index_jobs
    with _guard:
        if _maintenance_active or (
            expected_generation is not None and expected_generation != _index_generation
        ):
            return False
        _active_index_jobs += 1
        return True


def end_index_job():
    global _active_index_jobs
    with _guard:
        _active_index_jobs = max(0, _active_index_jobs - 1)
        _guard.notify_all()


@contextmanager
def maintenance_window(wait_for_jobs: bool = False, timeout: float = 60):
    global _index_generation, _maintenance_active
    with _guard:
        if _maintenance_active or (_active_index_jobs and not wait_for_jobs):
            raise IndexBusyError("Indexing is in progress")
        _maintenance_active = True
        _index_generation += 1
        deadline = time.monotonic() + timeout
        while _active_index_jobs:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                _maintenance_active = False
                _guard.notify_all()
                raise IndexBusyError("Indexing did not stop in time")
            _guard.wait(remaining)
    try:
        yield
    finally:
        with _guard:
            _maintenance_active = False
