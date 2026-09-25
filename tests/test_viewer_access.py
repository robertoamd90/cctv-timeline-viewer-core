import asyncio
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

import httpx

from ctv_server import db
from ctv_server.main import app


class ViewerAccessTests(unittest.TestCase):
    def test_published_configuration_and_api_permissions(self):
        config = json.loads((Path(__file__).resolve().parents[1] /
                             'packaging/homeassistant/config.base.json').read_text())
        self.assertFalse(config['panel_admin'])
        self.assertEqual(config['environment']['CTV_HA_ADMIN_ONLY'], '0')

        async def check():
            transport = httpx.ASGITransport(app=app, client=('172.30.32.2', 1234))
            async with httpx.AsyncClient(transport=transport, base_url='http://ctv',
                                        headers={'X-Remote-User-Id': 'viewer'}) as client:
                with patch('ctv_server.auth.resolve_admin', new=AsyncMock(return_value=(False, True))):
                    response = await client.get('/api/session')
                    self.assertEqual(response.status_code, 200)
                    self.assertFalse(response.json()['is_admin'])
                    for url in ['/api/cameras', '/api/timeline?from=100&to=200']:
                        self.assertEqual((await client.get(url)).status_code, 200, url)
                    for method, url, body in [
                        ('GET', '/api/admin/autoscan-settings', None),
                        ('GET', '/api/admin/ha-event-entities', None),
                        ('POST', '/api/admin/rebuild-index', None),
                        ('DELETE', '/api/cameras/1', None),
                        ('PUT', '/api/admin/autoscan-settings', {'enabled': True, 'interval_minutes': 60}),
                    ]:
                        self.assertEqual((await client.request(method, url, json=body)).status_code, 403, url)
                with patch('ctv_server.auth.resolve_admin', new=AsyncMock(return_value=(True, True))):
                    self.assertEqual((await client.get('/api/admin/autoscan-settings')).status_code, 200)
                client.headers.clear()
                self.assertEqual((await client.get('/api/session')).status_code, 401)

        with tempfile.TemporaryDirectory() as directory, patch.object(db, 'DB_PATH', os.path.join(directory, 'test.db')), patch.dict(os.environ, config['environment']):
            db.init_db()
            asyncio.run(check())
