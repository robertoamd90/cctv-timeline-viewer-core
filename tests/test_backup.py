import sqlite3
import tempfile
from pathlib import Path
import unittest
import threading
from ctv_server.backup import create_snapshot, restore_snapshot


class BackupTests(unittest.TestCase):
    def test_online_snapshot_during_concurrent_commits(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / 'ctv.db'
            with sqlite3.connect(database) as conn:
                conn.execute('PRAGMA journal_mode=WAL')
                conn.execute('CREATE TABLE data(value INTEGER PRIMARY KEY)')
            stop = threading.Event()
            ready = threading.Event()
            errors = []
            def writer():
                try:
                    with sqlite3.connect(database) as conn:
                        value = 0
                        while not stop.is_set():
                            conn.execute('INSERT INTO data VALUES(?)', (value,))
                            conn.commit()
                            value += 1
                            ready.set()
                            stop.wait(0.001)
                except Exception as exc:
                    errors.append(exc)
            worker = threading.Thread(target=writer)
            worker.start()
            try:
                self.assertTrue(ready.wait(2))
                for _ in range(3):
                    snapshot = create_snapshot(database)
                    with sqlite3.connect(snapshot) as conn:
                        self.assertEqual(conn.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
                        count, largest = conn.execute('SELECT COUNT(*), MAX(value) FROM data').fetchone()
                        self.assertEqual(count, largest + 1)
                self.assertTrue(worker.is_alive())
            finally:
                stop.set()
                worker.join(3)
            self.assertEqual(errors, [])

    def test_restored_archive_prefers_snapshot_over_live_files(self):
        import shutil
        with tempfile.TemporaryDirectory() as directory:
            original = Path(directory) / 'original'
            restored = Path(directory) / 'restored'
            original.mkdir()
            restored.mkdir()
            database = original / 'ctv.db'
            with sqlite3.connect(database) as source:
                source.execute('CREATE TABLE data(value)')
                source.execute('INSERT INTO data VALUES(1)')
            restore_snapshot(database)
            create_snapshot(database)
            with sqlite3.connect(database) as source:
                source.execute('INSERT INTO data VALUES(2)')
            for path in original.iterdir():
                if path.name != '.ctv-live':
                    shutil.copyfile(path, restored / path.name)
            self.assertTrue(restore_snapshot(restored / 'ctv.db'))
            with sqlite3.connect(restored / 'ctv.db') as source:
                self.assertEqual(source.execute('SELECT value FROM data').fetchall(), [(1,)])
            self.assertFalse(restore_snapshot(database))

    def test_wal_snapshot_restores_committed_data_without_stopping_writer(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / 'ctv.db'
            source = sqlite3.connect(database)
            try:
                source.execute('PRAGMA journal_mode=WAL')
                source.execute('CREATE TABLE data(value)')
                source.execute('INSERT INTO data VALUES(1)')
                source.commit()
                self.assertFalse(restore_snapshot(database))
                snapshot = create_snapshot(database)
                source.execute('INSERT INTO data VALUES(2)')
                source.commit()
                self.assertFalse(restore_snapshot(database))
                self.assertEqual(source.execute('SELECT COUNT(*) FROM data').fetchone()[0], 2)
            finally:
                source.close()
            database.unlink()
            self.assertTrue(restore_snapshot(database))
            self.assertFalse(snapshot.exists())
            with sqlite3.connect(database) as restored:
                self.assertEqual(restored.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
                self.assertEqual(restored.execute('SELECT value FROM data').fetchall(), [(1,)])

    def test_missing_source_does_not_create_empty_backup(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / 'missing.db'
            with self.assertRaises(sqlite3.OperationalError):
                create_snapshot(database)
            self.assertFalse(database.exists())
            self.assertEqual(list(Path(directory).iterdir()), [])
