"""Serialize partition scans; queued interactive requests precede background work."""
import threading
from contextlib import contextmanager

_condition = threading.Condition()
_running = False
_foreground_waiters = 0


@contextmanager
def partition_slot(background=False):
    global _running, _foreground_waiters
    admitted = False
    with _condition:
        if background:
            if not _running and not _foreground_waiters:
                _running = admitted = True
        else:
            _foreground_waiters += 1
            try:
                while _running:
                    _condition.wait()
                _running = admitted = True
            finally:
                _foreground_waiters -= 1
    try:
        yield admitted
    finally:
        if admitted:
            with _condition:
                _running = False
                _condition.notify_all()
