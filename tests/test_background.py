import threading
import unittest
from unittest.mock import patch
from ctv_server.background import DerivedWorker
from ctv_server.lifecycle import stopping


class DerivedWorkerTests(unittest.TestCase):
    def test_many_scans_use_one_worker_and_bounded_coalesced_queue(self):
        stopping.clear()
        worker = DerivedWorker(limit=16)
        entered, release = threading.Event(), threading.Event()
        finished = []
        def slow():
            entered.set()
            release.wait(3)
        worker.submit('first', slow)
        self.assertTrue(entered.wait(1))
        thread = worker.thread
        try:
            for index in range(1000):
                worker.submit(index % 100, finished.append, index)
            with worker.lock:
                self.assertLessEqual(len(worker.pending), 16)
            self.assertIs(worker.thread, thread)
            self.assertEqual(len([t for t in threading.enumerate() if t.name == 'ctv-thumbnails']), 1)
        finally:
            release.set()
            thread.join(3)
        self.assertFalse(thread.is_alive())
        self.assertEqual(finished, list(range(984, 1000)))
        self.assertIsNone(worker.thread)

    def test_failure_does_not_kill_queue_or_scan(self):
        stopping.clear()
        worker = DerivedWorker()
        with patch('ctv_server.background.threading.Thread.start', side_effect=RuntimeError("can't start new thread")):
            with self.assertLogs('ctv.background', level='ERROR'):
                self.assertFalse(worker.submit('first', lambda: None))
        self.assertIsNone(worker.thread)
        self.assertFalse(worker.pending)
        completed = threading.Event()
        self.assertTrue(worker.submit('retry', completed.set))
        self.assertTrue(completed.wait(1))
