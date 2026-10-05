"""Exercise real SIGTERM with SSE open, concurrent SQLite work and a child process."""
import concurrent.futures
import http.client
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest


SERVER = r'''
import asyncio, os, sys, threading
from pathlib import Path
import uvicorn
from ctv_server.server import Server
from ctv_server import db
from ctv_server.lifecycle import stopping, run_process, ShutdownRequested

def writer():
    try:
        while not stopping.wait(0.01):
            with db.write_db() as conn:
                conn.execute("UPDATE cameras SET last_scan_started=COALESCE(last_scan_started,0)+1")
    except ShutdownRequested:
        pass

def child():
    try:
        run_process([sys.executable, '-c', 'import time;time.sleep(60)'])
    except ShutdownRequested:
        pass

class TestServer(Server):
    async def startup(self, sockets=None):
        await super().startup(sockets)
        with db.write_db() as conn:
            conn.execute("INSERT OR IGNORE INTO cameras(id,name,source_path) VALUES(1,'test','/media/test')")
            for key in range(1,4):
                conn.execute("INSERT OR IGNORE INTO recordings(id,camera_id,path,filename,start_ts,end_ts,duration,availability) VALUES(?,1,?,'test.mp4',0,60,60,'available')",(key,os.environ['TEST_VIDEO']+str(key)))
        self.workers = [asyncio.create_task(asyncio.to_thread(worker)) for worker in (writer,child)]
        Path(os.environ['READY_FILE']).write_text(str(self.servers[0].sockets[0].getsockname()[1]))
    async def shutdown(self, sockets=None):
        await super().shutdown(sockets)
        await asyncio.gather(*self.workers)

TestServer(uvicorn.Config('ctv_server.main:app', host='127.0.0.1', port=0,
    proxy_headers=False, timeout_graceful_shutdown=5)).run()
'''


class ShutdownProcessTests(unittest.TestCase):
    def test_three_restart_cycles_with_readers_writer_and_open_sse(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for key in range(1,4):
                (root / f'video{key}').write_bytes(b'video fixture' * 10000)
            env = {**os.environ, 'CTV_DB': str(root / 'ctv.db'),
                   'CTV_DEPLOYMENT': 'standalone', 'READY_FILE': str(root / 'ready'),
                   'TEST_VIDEO': str(root / 'video')}
            for cycle in range(3):
                ready = root / 'ready'
                ready.unlink(missing_ok=True)
                with open(root / f'run-{cycle}.log', 'w+') as log:
                    process = subprocess.Popen([sys.executable, '-c', SERVER], env=env,
                                               stdout=log, stderr=log)
                    stream = None
                    try:
                        deadline = time.monotonic() + 10
                        while not ready.exists() and process.poll() is None and time.monotonic() < deadline:
                            time.sleep(0.02)
                        log.flush()
                        self.assertTrue(ready.exists(), (root / f'run-{cycle}.log').read_text())
                        port = int(ready.read_text())
                        stream = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
                        stream.request('GET', '/api/events')
                        response = stream.getresponse()
                        self.assertEqual(response.status, 200)
                        self.assertIn(b'connected', response.readline())
                        def read(camera):
                            conn = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
                            try:
                                for _ in range(20):
                                    conn.request('GET', f'/video/{camera}', headers={'Range':'bytes=0-1023'})
                                    result = conn.getresponse()
                                    self.assertEqual(result.status, 206)
                                    self.assertEqual(len(result.read()), 1024)
                            finally:
                                conn.close()
                        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
                            list(pool.map(read, [1,2,3]))
                        process.send_signal(signal.SIGTERM)
                        process.wait(timeout=12)
                        self.assertEqual(process.returncode, 0)
                        connection = sqlite3.connect(root / 'ctv.db', timeout=1)
                        try:
                            self.assertEqual(connection.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
                            self.assertEqual(connection.execute('SELECT COUNT(*) FROM recordings').fetchone()[0], 3)
                        finally:
                            connection.close()
                    finally:
                        if stream:
                            stream.close()
                        if process.poll() is None:
                            process.kill()
                            process.wait(timeout=5)
