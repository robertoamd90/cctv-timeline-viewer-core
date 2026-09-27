"""Serialize partition scans; queued interactive requests precede background work."""
from ctv_server.lifecycle import stopping

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
            if not stopping.is_set() and not _running and not _foreground_waiters:
                _running = admitted = True
        else:
            _foreground_waiters += 1
            try:
                while _running and not stopping.is_set():
                    _condition.wait(0.2)
                if not stopping.is_set():
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
