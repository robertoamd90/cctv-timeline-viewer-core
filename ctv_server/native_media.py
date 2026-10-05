"""Bounded, pinned copies of fragmented MP4s with a complete seek index."""
from collections import OrderedDict
import logging
import os
from pathlib import Path
import tempfile
import threading
import time

from ctv_server.lifecycle import run_process, check_running
from ctv_server.mp4 import _boxes, _children

log = logging.getLogger('ctv.native_media')


def fragmented(path):
    with open(path, 'rb') as source:
        header = source.read(64 * 1024)
    moov = next((box for box in _boxes(header, 0, len(header)) if box[3] == b'moov'), None)
    return bool(moov and any(box[3] == b'mvex' for box in _children(header, moov)))


class NativeMediaCache:
    def __init__(self, limit=None):
        self.limit = limit if limit is not None else int(os.environ.get('CTV_NATIVE_CACHE_MB', '256')) * 1024 * 1024
        self.lock = threading.Lock()
        self.available = threading.Condition(self.lock)
        self.entries = OrderedDict()
        self.building = {}
        self.directory = None

    def acquire(self, path):
        stat = os.stat(path)
        if Path(path).suffix.lower() != '.mp4' or not fragmented(path):
            return path, lambda: None
        required = stat.st_size + max(1024 * 1024, stat.st_size // 10)
        if required > self.limit:
            # This decision depends only on this file version and cache limit,
            # never on concurrent requests. Every Range sees the same bytes.
            return path, lambda: None
        key = (os.path.realpath(path), stat.st_mtime_ns, stat.st_size)
        space_deadline = time.monotonic() + 5
        preparation_deadline = time.monotonic() + 30
        with self.available:
            while True:
                check_running()
                entry = self.entries.get(key)
                if entry is not None:
                    entry['pins'] += 1
                    self.entries.move_to_end(key)
                    return entry['path'], self._releaser(entry)
                if key in self.building:
                    if time.monotonic() >= preparation_deadline:
                        raise RuntimeError('Native MP4 preparation is still in progress')
                    self.available.wait(timeout=0.2)
                    continue
                occupied = sum(e['size'] for e in self.entries.values()) + sum(self.building.values())
                for old_key, old in list(self.entries.items()):
                    if occupied + required <= self.limit:
                        break
                    if old['pins'] == 0:
                        Path(old['path']).unlink(missing_ok=True)
                        occupied -= old['size']
                        del self.entries[old_key]
                if occupied + required <= self.limit:
                    if self.directory is None:
                        self.directory = tempfile.TemporaryDirectory(prefix='ctv-native-')
                    directory = self.directory.name
                    self.building[key] = required
                    break
                if time.monotonic() >= space_deadline:
                    raise RuntimeError('Native cache busy: all remaining copies are in use')
                self.available.wait(timeout=0.2)

        # A slow or invalid recording must not lock out cache hits, releases,
        # or preparation of other recordings. Reserve capacity before unlocking.
        output = None
        try:
            fd, output = tempfile.mkstemp(suffix='.mp4', dir=directory)
            os.close(fd)
            run_process(['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
                         '-i', str(path), '-map', '0:v:0', '-map', '0:a?', '-c', 'copy',
                         '-movflags', '+faststart', '-fs', str(required), output], check=True, timeout=25)
            size = os.stat(output).st_size
            if size >= required or size == 0:
                raise RuntimeError('Native MP4 copy exceeded its reserved size')
            current = os.stat(path)
            if (current.st_mtime_ns, current.st_size) != (stat.st_mtime_ns, stat.st_size):
                raise RuntimeError('Recording changed during native MP4 preparation')
            entry = {'path': output, 'size': size, 'pins': 1}
            log.info('Prepared indexed native MP4: %s (%s bytes)', path, size)
            with self.available:
                self.building.pop(key, None)
                self.entries[key] = entry
            return entry['path'], self._releaser(entry)
        except BaseException:
            if output is not None:
                Path(output).unlink(missing_ok=True)
            raise
        finally:
            with self.available:
                self.building.pop(key, None)
                self.available.notify_all()

    def _releaser(self, entry):
        def release():
            with self.lock:
                entry['pins'] -= 1
                self.available.notify_all()
        return release


native_cache = NativeMediaCache()
