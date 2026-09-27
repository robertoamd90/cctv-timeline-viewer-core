import asyncio
from contextlib import closing
import os
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import httpx

from ctv_server import db
from ctv_server.main import app


class DatabaseContentionTests(unittest.TestCase):
    def test_busy_video_returns_retryable_response_and_closes_connection(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(db, 'DB_PATH', os.path.join(directory, 'ctv.db')):
            db.init_db()
            opened = []

            def connect():
                conn = db.get_db()
                conn.execute('PRAGMA busy_timeout=0')
                opened.append(conn)
                return conn

            async def request():
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://ctv') as client:
                    response = await client.get('/video/1')
                    self.assertEqual(response.status_code, 503)
                    self.assertEqual(response.json(), {'detail': 'database_busy'})
                    self.assertEqual(response.headers['retry-after'], '2')

            with closing(db.get_db()) as blocker:
                blocker.execute('PRAGMA journal_mode=DELETE')
                blocker.execute('BEGIN EXCLUSIVE')
                try:
                    with patch('ctv_server.main.get_db', side_effect=connect), patch.dict(os.environ, {'CTV_DEPLOYMENT': 'standalone'}):
                        asyncio.run(request())
                finally:
                    blocker.rollback()
            self.assertTrue(opened)
            for conn in opened:
                with self.assertRaises(sqlite3.ProgrammingError):
                    conn.execute('SELECT 1')

    def test_wal_readers_continue_during_uncommitted_writer(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(db, 'DB_PATH', os.path.join(directory, 'ctv.db')):
            db.init_db()
            with closing(db.get_db()) as writer:
                self.assertEqual(writer.execute('PRAGMA journal_mode').fetchone()[0], 'wal')
                writer.execute('BEGIN IMMEDIATE')
                writer.execute("INSERT INTO cameras (name,source_path) VALUES ('pending','/media/test')")
                try:
                    for _ in range(30):
                        with closing(db.get_db()) as reader:
                            reader.execute('PRAGMA busy_timeout=0')
                            self.assertEqual(reader.execute('SELECT COUNT(*) FROM cameras').fetchone()[0], 0)
                finally:
                    writer.rollback()

    def test_missing_table_is_not_misreported_as_temporary_lock(self):
        from ctv_server.main import database_operational_error
        error = sqlite3.OperationalError('no such table: recordings')
        with self.assertRaises(sqlite3.OperationalError):
            asyncio.run(database_operational_error(None, error))
