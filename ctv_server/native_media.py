"""Bounded, pinned copies of fragmented MP4s with a complete seek index."""
from collections import OrderedDict
import logging
import os
from pathlib import Path
import subprocess
import tempfile
import threading

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
        self.entries = OrderedDict()
        self.directory = None

    def acquire(self, path):
        stat = os.stat(path)
        if Path(path).suffix.lower() != '.mp4' or not fragmented(path):
            return path, lambda: None
        key = (os.path.realpath(path), stat.st_mtime_ns, stat.st_size)
        while not self.lock.acquire(timeout=0.2):
            check_running()
        try:
            check_running()
            entry = self.entries.get(key)
            if entry is None:
                # Reserve room for mux overhead. Never evict a response's file.
                required = stat.st_size + max(1024 * 1024, stat.st_size // 10)
                for old_key, old in list(self.entries.items()):
                    if sum(e['size'] for e in self.entries.values()) + required <= self.limit:
                        break
                    if old['pins'] == 0:
                        Path(old['path']).unlink(missing_ok=True)
                        del self.entries[old_key]
                if sum(e['size'] for e in self.entries.values()) + required > self.limit:
                    # Large archives remain readable without unbounded copies.
                    log.warning('Native cache full; serving original fragmented file: %s', path)
                    return path, lambda: None
                if self.directory is None:
                    self.directory = tempfile.TemporaryDirectory(prefix='ctv-native-')
                fd, output = tempfile.mkstemp(suffix='.mp4', dir=self.directory.name)
                os.close(fd)
                try:
                    run_process(['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
                                 '-i', str(path), '-map', '0:v:0', '-map', '0:a?', '-c', 'copy',
                                 '-movflags', '+faststart', '-fs', str(required), output], check=True, timeout=25)
                    size = os.stat(output).st_size
                    if size >= required or size == 0:
                        raise RuntimeError('Native MP4 copy exceeded its reserved size')
                    entry = {'path': output, 'size': size, 'pins': 0}
                    self.entries[key] = entry
                    log.info('Prepared indexed native MP4: %s (%s bytes)', path, size)
                except (subprocess.SubprocessError, OSError, RuntimeError):
                    Path(output).unlink(missing_ok=True)
                    raise
            entry['pins'] += 1
            self.entries.move_to_end(key)
        finally:
            self.lock.release()

        def release():
            with self.lock:
                entry['pins'] -= 1

        return entry['path'], release


native_cache = NativeMediaCache()
