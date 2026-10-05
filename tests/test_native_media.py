import subprocess
import tempfile
from pathlib import Path
import unittest
import threading
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
from ctv_server import native_media
from ctv_server.native_media import NativeMediaCache, fragmented
from ctv_server.lifecycle import stopping


class NativeMediaTests(unittest.TestCase):
    def test_fragmented_copy_is_seekable_reused_and_pinned(self):
        stopping.clear()
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'source.mp4'
            subprocess.run(['ffmpeg','-nostdin','-v','error','-f','lavfi','-i',
                            'testsrc2=size=160x120:rate=10','-t','2','-c:v','libx264',
                            '-movflags','frag_keyframe+empty_moov',str(source)],check=True)
            original = source.read_bytes()
            cache = NativeMediaCache(limit=4*1024*1024)
            try:
                self.assertTrue(fragmented(source))
                prepared, release = cache.acquire(source)
                again, release_again = cache.acquire(source)
                self.assertEqual(prepared, again)
                self.assertFalse(fragmented(prepared))
                self.assertEqual(source.read_bytes(), original)
                self.assertEqual(next(iter(cache.entries.values()))['pins'], 2)
                subprocess.run(['ffmpeg','-nostdin','-v','error','-ss','1','-i',prepared,
                                '-frames:v','1','-f','null','-'],check=True)
                release()
                release_again()
                self.assertEqual(next(iter(cache.entries.values()))['pins'], 0)
            finally:
                if cache.directory:
                    cache.directory.cleanup()

    def test_slow_preparation_does_not_block_hits_and_deduplicates_waiters(self):
        stopping.clear()
        with tempfile.TemporaryDirectory() as directory:
            first = Path(directory) / 'first.mp4'
            second = Path(directory) / 'second.mp4'
            subprocess.run(['ffmpeg','-nostdin','-v','error','-f','lavfi','-i',
                            'testsrc2=size=160x120:rate=10','-t','2','-c:v','libx264',
                            '-movflags','frag_keyframe+empty_moov',str(first)],check=True)
            second.write_bytes(first.read_bytes())
            cache = NativeMediaCache(limit=4*1024*1024)
            entered, proceed = threading.Event(), threading.Event()
            original = native_media.run_process
            builds = []
            def slow(command, **kwargs):
                builds.append(command)
                entered.set()
                if not proceed.wait(3):
                    raise RuntimeError('Test timed out waiting for cache hit')
                return original(command, **kwargs)
            try:
                prepared, release = cache.acquire(first)
                release()
                with ThreadPoolExecutor(max_workers=3) as pool, patch.object(native_media, 'run_process', side_effect=slow):
                    pending = pool.submit(cache.acquire, second)
                    self.assertTrue(entered.wait(1))
                    duplicate = pool.submit(cache.acquire, second)
                    hit, release_hit = pool.submit(cache.acquire, first).result(timeout=1)
                    self.assertEqual(hit, prepared)
                    release_hit()
                    proceed.set()
                    built, release_built = pending.result(timeout=3)
                    same, release_same = duplicate.result(timeout=3)
                    self.assertEqual(built, same)
                    self.assertEqual(len(builds), 1)
                    release_built()
                    release_same()
                self.assertFalse(cache.building)
                self.assertTrue(all(entry['pins'] == 0 for entry in cache.entries.values()))
            finally:
                proceed.set()
                if cache.directory:
                    cache.directory.cleanup()
