import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from ctv_server import db
from ctv_server.lifecycle import stopping, ShutdownRequested, run_process
from ctv_server.operations import begin_index_job
from ctv_server.index_queue import partition_slot


class ShutdownTests(unittest.TestCase):
    def tearDown(self):
        stopping.clear()

    def test_shutdown_rejects_new_scans_and_releases_queued_scans(self):
        result = []
        def queued():
            with partition_slot() as admitted:
                result.append(admitted)
        with partition_slot() as admitted:
            self.assertTrue(admitted)
            worker = threading.Thread(target=queued)
            worker.start()
            stopping.set()
            worker.join(2)
            self.assertFalse(worker.is_alive())
            self.assertFalse(begin_index_job())
        self.assertEqual(result, [False])

    def test_cancelled_writer_rolls_back_and_database_can_reopen(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(db, 'DB_PATH', os.path.join(directory, 'ctv.db')):
            db.init_db()
            with self.assertRaises(ShutdownRequested):
                with db.write_db() as conn:
                    conn.execute("INSERT INTO cameras (name,source_path) VALUES ('pending','/media/test')")
                    stopping.set()
            stopping.clear()
            with db.write_db() as conn:
                self.assertEqual(conn.execute('SELECT COUNT(*) FROM cameras').fetchone()[0], 0)
                self.assertEqual(conn.execute('PRAGMA integrity_check').fetchone()[0], 'ok')

    def test_shutdown_kills_and_reaps_probe(self):
        errors = []
        with tempfile.TemporaryDirectory() as directory:
            pid_file = Path(directory) / 'pid'
            def probe():
                try:
                    run_process([sys.executable, '-c',
                                 'import os,time,sys;open(sys.argv[1],"w").write(str(os.getpid()));time.sleep(60)', str(pid_file)])
                except ShutdownRequested:
                    errors.append('cancelled')
            worker = threading.Thread(target=probe)
            worker.start()
            try:
                deadline = time.monotonic() + 5
                while not pid_file.exists() and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(pid_file.exists())
                pid = int(pid_file.read_text())
                stopping.set()
                worker.join(3)
                self.assertFalse(worker.is_alive())
                self.assertEqual(errors, ['cancelled'])
                with self.assertRaises(ProcessLookupError):
                    os.kill(pid, 0)
            finally:
                stopping.set()
                worker.join(5)

    def test_manifest_uses_online_snapshot_and_enables_init(self):
        import json
        config = json.loads((Path(__file__).resolve().parents[1] / 'packaging/homeassistant/config.base.json').read_text())
        self.assertTrue(config['init'])
        self.assertEqual(config['backup'], 'hot')
        self.assertEqual(config['backup_pre'], 'python -m ctv_server.backup')
        self.assertIn('**/.ctv-live', config['backup_exclude'])
        # Supervisor matches the host data path, not the container /data path.
        host_marker = Path('/data/apps/data/example_ctv/.ctv-live')
        self.assertTrue(any(host_marker.match(pattern) for pattern in config['backup_exclude']))
        self.assertNotIn('/data/ctv.db', config['backup_exclude'])
        self.assertNotIn('/data/ctv.db.backup', config['backup_exclude'])
        self.assertGreaterEqual(config['timeout'], 30)
