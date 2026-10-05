"""Exercise the production server inside a container with --pids-limit=64."""
import asyncio
import os
from pathlib import Path
import subprocess
import tempfile
import threading

import uvicorn


async def main():
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        os.environ['CTV_DB'] = str(root / 'ctv.db')
        os.environ['CTV_DEPLOYMENT'] = 'standalone'
        os.environ['CTV_THUMBNAILS'] = str(root / 'thumbnails')
        source = root / 'source.mp4'
        subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-filter_threads', '1', '-filter_complex_threads', '1', '-f', 'lavfi', '-i',
                        'testsrc2=size=160x120:rate=10', '-t', '2', '-threads', '1',
                        '-c:v', 'libx264', '-movflags', 'frag_keyframe+empty_moov', str(source)], check=True)
        from ctv_server.main import app
        from ctv_server.server import Server
        from ctv_server import db
        from ctv_server.partition_service import _thumbnail_queue
        release = threading.Event()
        entered = []
        @app.get('/test/occupy-worker')
        def occupy():
            entered.append(True)
            if not release.wait(10):
                raise RuntimeError('Pressure test timed out')
            return {'ok': True}
        # The application mounts static files at '/'; put the test route first.
        app.router.routes.insert(0, app.router.routes.pop())
        server = Server(uvicorn.Config(app, host='127.0.0.1', port=0, log_level='warning', access_log=False))
        running = asyncio.create_task(server.serve())
        blockers = []
        async def request(url, headers=''):
            reader, writer = await asyncio.open_connection('127.0.0.1', port)
            try:
                writer.write(f'GET {url} HTTP/1.1\r\nHost: test\r\nConnection: close\r\n{headers}\r\n'.encode())
                await writer.drain()
                return await asyncio.wait_for(reader.read(), 10)
            finally:
                writer.close()
                await writer.wait_closed()
        thumbnail_release = threading.Event()
        try:
            for _ in range(500):
                if server.started:
                    break
                if running.done():
                    await running
                    raise RuntimeError('Server stopped before startup')
                await asyncio.sleep(0.01)
            assert server.started
            port = server.servers[0].sockets[0].getsockname()[1]
            with db.write_db() as conn:
                conn.execute('UPDATE autoscan_settings SET enabled=0')
                for key in range(1,5):
                    clip = root / f'video-{key}.mp4'
                    clip.write_bytes(source.read_bytes())
                    conn.execute('INSERT INTO cameras(id,name,source_path) VALUES(?,?,?)', (key, str(key), str(root)))
                    conn.execute('INSERT INTO recordings(id,camera_id,path,filename,start_ts,end_ts,duration,availability) VALUES(?,?,?, ?,0,2,2,\'available\')', (key,key,str(clip),clip.name))
            blockers = [asyncio.create_task(request('/test/occupy-worker')) for _ in range(12)]
            for _ in range(500):
                if len(entered) == 12:
                    break
                await asyncio.sleep(0.01)
            assert len(entered) == 12
            for url in ['/api/health', '/api/events/poll']:
                response = await asyncio.wait_for(request(url), 2)
                assert response.startswith(b'HTTP/1.1 200'), response[:200]
            release.set()
            assert all(reply.startswith(b'HTTP/1.1 200') for reply in await asyncio.gather(*blockers))
            thumbnail_entered = threading.Event()
            def thumbnail():
                thumbnail_entered.set()
                thumbnail_release.wait(10)
            _thumbnail_queue.submit('slow', thumbnail)
            while not thumbnail_entered.is_set():
                await asyncio.sleep(0.01)
            for key in range(1000):
                _thumbnail_queue.submit(key, lambda: None)
            assert len(_thumbnail_queue.pending) <= 64
            assert len([t for t in threading.enumerate() if t.name == 'ctv-thumbnails']) == 1
            for batch in range(10):
                replies = await asyncio.gather(*(request(f'/video/{key % 4 + 1}', 'Range: bytes=0-1023\r\n') for key in range(12)))
                assert all(reply.startswith(b'HTTP/1.1 206') for reply in replies)
                assert (await request('/api/health')).startswith(b'HTTP/1.1 200')
            threads = threading.active_count()
            assert threads <= 24, threads
            print(f'Resource pressure passed: 1000 queued thumbnail requests, 120 video ranges, saturated request pool; {threads} Python threads', flush=True)
        finally:
            release.set()
            thumbnail_release.set()
            if blockers:
                await asyncio.gather(*blockers, return_exceptions=True)
            server.should_exit = True
            await running


if __name__ == '__main__':
    asyncio.run(main())
