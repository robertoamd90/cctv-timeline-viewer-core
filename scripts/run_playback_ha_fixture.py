"""Local synthetic HA deployment, using a mock Core solely for user roles.

Not Home Assistant/Supervisor itself. Production middleware and authentication
remain enabled; the loopback proxy supplies the synthetic Ingress identity.
Usage: python scripts/run_playback_ha_fixture.py /private/tmp/ctv-fixture-NAME
"""
import asyncio
import os
from pathlib import Path
import sys


async def main():
    root = Path(sys.argv[1]).resolve()
    if root.parent != Path('/private/tmp') or not root.name.startswith('ctv-fixture-'):
        raise SystemExit('Synthetic /private/tmp/ctv-fixture-* directories only')
    if not (root / 'candidate.db').is_file():
        raise SystemExit('Create the synthetic fixture first')
    if os.environ.get('SUPERVISOR_TOKEN'):
        raise SystemExit('Refusing an environment containing a real Supervisor token')
    os.environ.update(CTV_DB=str(root / 'candidate.db'), CTV_HLS_ROOT=str(root / 'hls'),
                      CTV_SOURCE_ROOTS=str(root), CTV_DEPLOYMENT='homeassistant',
                      CTV_HA_WEBSOCKET_URL='ws://127.0.0.1:8767/api/websocket',
                      SUPERVISOR_TOKEN='synthetic-fixture-token')
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    import uvicorn
    from fastapi import FastAPI, WebSocket
    from ctv_server.main import app
    core = FastAPI()

    @core.websocket('/api/websocket')
    async def roles(socket: WebSocket):
        await socket.accept()
        await socket.send_json({'type': 'auth_required'})
        auth = await socket.receive_json()
        if auth != {'type': 'auth', 'access_token': 'synthetic-fixture-token'}:
            await socket.close(code=1008)
            return
        await socket.send_json({'type': 'auth_ok'})
        command = await socket.receive_json()
        await socket.send_json({'id': command['id'], 'type': 'result',
                                'success': command['type'] == 'config/auth/list',
                                'result': [{'id': 'fixture-user', 'is_active': True,
                                            'group_ids': ['system-admin']}]})
        await socket.close()

    servers = [uvicorn.Server(uvicorn.Config(target, host='127.0.0.1', port=port,
                access_log=False, log_level='warning')) for target, port in [(app,8766),(core,8767)]]
    await asyncio.gather(*(server.serve() for server in servers))


if __name__ == '__main__':
    asyncio.run(main())
