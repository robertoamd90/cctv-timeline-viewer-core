import asyncio
import os
import tempfile
import threading
import unittest
from unittest.mock import patch
import anyio
import httpx
from ctv_server import db
from ctv_server.lifecycle import stopping
from ctv_server.main import app


class ResourcePressureTests(unittest.TestCase):
    def test_health_and_poll_respond_while_default_worker_pool_is_full(self):
        stopping.clear()
        with tempfile.TemporaryDirectory() as directory, patch.object(db, 'DB_PATH', os.path.join(directory, 'ctv.db')):
            db.init_db()
            async def exercise():
                limiter = anyio.to_thread.current_default_thread_limiter()
                original = limiter.total_tokens
                limiter.total_tokens = 1
                entered, release = threading.Event(), threading.Event()
                def occupy():
                    entered.set()
                    release.wait(3)
                occupied = asyncio.create_task(anyio.to_thread.run_sync(occupy))
                try:
                    while not entered.is_set():
                        await asyncio.sleep(0.01)
                    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
                        for endpoint in ['/api/health', '/api/events/poll']:
                            response = await asyncio.wait_for(client.get(endpoint), 0.5)
                            self.assertEqual(response.status_code, 200)
                        self.assertEqual((await client.get('/api/health')).json()['database'], 'ok')
                finally:
                    release.set()
                    await occupied
                    limiter.total_tokens = original
            asyncio.run(exercise())
