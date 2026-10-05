"""Bounded, coalescing work queue for optional derived data."""
from collections import OrderedDict
import logging
import threading
from ctv_server.lifecycle import stopping

log = logging.getLogger('ctv.background')


class DerivedWorker:
    def __init__(self, limit=64):
        self.limit = limit
        self.pending = OrderedDict()
        self.lock = threading.Lock()
        self.thread = None

    def submit(self, key, function, *args):
        with self.lock:
            if stopping.is_set():
                return False
            self.pending[key] = (function, args)
            self.pending.move_to_end(key)
            if len(self.pending) > self.limit:
                self.pending.popitem(last=False)
                # Derived thumbnails can be regenerated on a later scan.
            if self.thread is None:
                self.thread = threading.Thread(target=self._run, name='ctv-thumbnails', daemon=True)
                try:
                    self.thread.start()
                except RuntimeError:
                    self.thread = None
                    self.pending.clear()
                    log.exception('Unable to start optional thumbnail worker')
                    return False
            return True

    def _run(self):
        while True:
            with self.lock:
                if stopping.is_set() or not self.pending:
                    self.pending.clear()
                    self.thread = None
                    return
                _, (function, args) = self.pending.popitem(last=False)
            try:
                function(*args)
            except Exception:
                log.exception('Optional background task failed')
