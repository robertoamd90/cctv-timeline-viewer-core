import subprocess
import tempfile
from pathlib import Path
import unittest
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
