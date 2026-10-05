"""Slow network reads must retain worker capacity after browser cancellation."""
import asyncio
from contextvars import ContextVar
import tempfile
from pathlib import Path
import threading
import unittest
from unittest.mock import patch
import anyio
from ctv_server.main import VideoFileResponse


class SlowReadCancellationTests(unittest.TestCase):
    def test_abandoned_slow_reads_do_not_grow_workers_or_close_during_read(self):
        async def exercise(path):
            limiter = anyio.to_thread.current_default_thread_limiter()
            limiter.total_tokens = 2
            release = threading.Event()
            request_event = ContextVar("read_started")
            files = []
            returned = []
            released = []
            class SlowFile:
                def __init__(self):
                    self.started = request_event.get()
                    self.reading = False
                    self.closed = False
                def seek(self, offset, whence=0):
                    return offset
                def read(self, size):
                    self.reading = True
                    self.started.set()
                    release.wait(5)
                    self.reading = False
                    returned.append(True)
                    return b'x' * size
                def close(self):
                    self.assert_safe = not self.reading
                    self.closed = True
            async def open_file(*args, **kwargs):
                file = SlowFile()
                files.append(file)
                return anyio.AsyncFile(file)
            async def send(message):
                await asyncio.sleep(0)
            scope = {'type':'http', 'method':'GET', 'headers':[(b'range',b'bytes=0-1023')], 'extensions':{}}
            async def perform():
                started = threading.Event()
                request_event.set(started)
                async def receive():
                    while not started.is_set():
                        await asyncio.sleep(0.001)
                    return {'type':'http.disconnect'}
                return await VideoFileResponse(path, release=lambda: released.append(True))(scope,receive,send)
            baseline = threading.active_count()
            tasks = []
            try:
                with patch('ctv_server.main.anyio.open_file', new=open_file):
                    for _ in range(100):
                        tasks.append(asyncio.create_task(perform()))
                        await asyncio.sleep(0.002)
                    self.assertLessEqual(threading.active_count(), baseline + 2)
                    self.assertEqual(returned, [], 'blocked reads must still occupy their workers')
                    self.assertEqual(released, [], 'cache pins must remain until reads finish')
                    self.assertFalse(any(file.closed and file.reading for file in files))
                    release.set()
                    await asyncio.wait_for(asyncio.gather(*tasks), 3)
            finally:
                release.set()
                await asyncio.gather(*tasks, return_exceptions=True)
            self.assertTrue(all(file.closed and file.assert_safe for file in files))
            self.assertEqual(limiter.borrowed_tokens, 0)
            self.assertEqual(len(released), 100)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'video.mp4'
            path.write_bytes(b'x' * 2048)
            asyncio.run(exercise(path))


if __name__ == '__main__':
    unittest.main()
