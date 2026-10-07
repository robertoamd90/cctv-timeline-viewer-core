"""Exercise the real PHP front controller with isolated archives and credentials."""
import base64
import contextlib
import http.client
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import struct
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
PHP = os.environ.get('PHP_BIN') or shutil.which('php')
assert PHP, 'Set PHP_BIN to a PHP CLI with pdo_sqlite'
PASSWORD = 'test-only-password'
AUTH = 'Basic ' + base64.b64encode(('tester:' + PASSWORD).encode()).decode()
checks = 0


def check(condition, message):
    global checks
    checks += 1
    assert condition, message


def box(kind, payload):
    return struct.pack('>I', len(payload) + 8) + kind.encode() + payload


def header(values, padding=0):
    return b'\0' * 4 + b''.join(struct.pack('>I', value) for value in values) + b'\0' * padding


@contextlib.contextmanager
def server(folder, env, prefix=''):
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    router = folder / 'router.php'
    router.write_text('<?php $_SERVER["SCRIPT_NAME"] = ' + json.dumps(prefix + '/index.php')
                      + '; require ' + json.dumps(str(ROOT / 'ctv_php/public/index.php')) + ';')
    with (folder / 'server.log').open('w+') as log:
        process = subprocess.Popen([PHP, '-S', f'127.0.0.1:{port}', '-t', str(ROOT / 'ctv_php/public'), str(router)], env=env, stdout=log, stderr=log)
        try:
            for _ in range(100):
                if process.poll() is not None:
                    log.seek(0)
                    raise AssertionError(log.read())
                try:
                    with socket.create_connection(('127.0.0.1', port), timeout=.1):
                        break
                except OSError:
                    time.sleep(.05)
            else:
                raise AssertionError('PHP test server did not start')

            def request(path, method='GET', headers=None, body=None, authenticated=True):
                sent = {'Authorization': AUTH} if authenticated else {}
                sent.update(headers or {})
                if isinstance(body, dict):
                    body = json.dumps(body)
                    sent['Content-Type'] = 'application/json'
                connection = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
                connection.request(method, prefix + path, body=body, headers=sent)
                response = connection.getresponse()
                result = response.status, dict(response.getheaders()), response.read()
                connection.close()
                return result

            yield request
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


with tempfile.TemporaryDirectory(prefix='ctv_http_') as temporary:
    tmp = Path(temporary)
    archive = tmp / 'archive'
    camera = archive / 'Camera'
    partition = camera / '2026/09/30'
    partition.mkdir(parents=True)
    (camera / '2026/10').mkdir(parents=True)
    (camera / '2026/10/01').symlink_to(tmp, target_is_directory=True)
    password_file = tmp / '.htpasswd'
    env = dict(os.environ, CTV_PHP_SOURCE_ROOTS=str(archive), CTV_PHP_DATA_DIR=str(tmp / 'data'),
               CTV_PHP_PASSWORD_FILE=str(password_file), CTV_PHP_ADMIN='1')
    # Keep fixture credentials separate from any deployment configuration.
    result = subprocess.run([PHP, '-r', 'echo password_hash("test-only-password", PASSWORD_BCRYPT, ["cost"=>4]);'], env=env, capture_output=True, text=True, check=True)
    password_file.write_text('tester:' + result.stdout + '\n')
    mp4 = box('ftyp', b'isom' + b'\0' * 12) + box('moov', box('mvhd', header([0, 0, 1000, 28800], 80)))
    video = partition / 'Camera_00_20260930001821.mp4'
    video.write_bytes(mp4)
    os.utime(video, (time.time() - 120, time.time() - 120))
    thumbnail = partition / 'Camera_00_20260930001819.jpg'
    thumbnail.write_bytes(b'\xff\xd8\xff\xd9')
    outside = tmp / 'outside.mp4'
    outside.write_bytes(mp4)
    (partition / 'Camera_00_20260930001921.mp4').symlink_to(outside)
    with server(tmp, env) as request:
        for path, method in [('/', 'GET'), ('/js/app.js', 'GET'), ('/api/session', 'GET'),
                             ('/video/1', 'GET'), ('/video/1', 'HEAD'),
                             ('/api/recordings/1/thumbnail', 'GET'), ('/api/cameras', 'POST'),
                             ('/api/admin/rebuild-index', 'POST'), ('/api/session', 'OPTIONS')]:
            status, headers, body = request(path, method, authenticated=False)
            check(status == 401 and 'WWW-Authenticate' in headers, f'Password required for {method} {path}')
        check(not (tmp / 'data/ctv.sqlite').exists(), 'Unauthenticated requests must not open/create SQLite')
        check(request('/api/session', headers={'Authorization': 'Basic ' + base64.b64encode(b'tester:wrong').decode()})[0] == 401, 'Wrong password refused')
        status, _, body = request('/api/session')
        session = json.loads(body)
        check(status == 200 and session['user']['name'] == 'tester', 'Session uses verified identity')
        check(session['is_admin'] and not session['capabilities']['transcoding'] and not session['capabilities']['realtime_events'], 'PHP capabilities match deployment')
        check(request('/')[1]['Cache-Control'] == 'no-cache', 'Frontend must revalidate')
        check(request('/js/app.js')[0] == 200, 'Authenticated frontend asset served')
        check(request('/js/../../ctv_php/config.example.php')[0] == 404, 'Static traversal refused')
        saved = password_file.read_text()
        password_file.unlink()
        check(request('/video/1')[0] == 503, 'Missing password file fails closed')
        password_file.write_text('tester:$apr1$unsupported\n')
        check(request('/api/session')[0] == 503, 'Unsupported password hashes fail closed')
        password_file.write_text(saved.replace('tester:', 'other-user:'))
        check(request('/api/session')[0] == 401, 'Removing a user immediately revokes credentials')
        password_file.write_text(saved)
        for path in ['/api/cameras', '/api/scan', '/api/admin/rebuild-index']:
            check(request(path, 'POST')[0] == 403, f'Cross-site form cannot invoke {path}')
            check(request(path, 'POST', {'X-CTV-Request': '1', 'Sec-Fetch-Site': 'cross-site'})[0] == 403, 'Cross-site mutation refused even with custom header')
        status, _, body = request('/api/cameras', 'POST', {'X-CTV-Request': '1'}, {'name': 'Camera', 'source_path': str(camera), 'timezone': 'Europe/Zurich'})
        check(status == 201, 'Camera creation works')
        camera_id = json.loads(body)['id']
        check(request('/api/cameras', 'POST', {'X-CTV-Request': '1'}, {'name': 'Duplicate', 'source_path': str(camera)})[0] == 409, 'Duplicate source returns conflict')
        cli = subprocess.run([PHP, str(ROOT / 'ctv_php/bin/index.php'), '--date=2026-09-30'], env=env, capture_output=True, text=True)
        check(cli.returncode == 0, 'CLI indexes valid date: ' + cli.stderr)
        with sqlite3.connect(tmp / 'data/ctv.sqlite') as db:
            check(db.execute('SELECT COUNT(*) FROM recordings').fetchone()[0] == 1, 'Indexer excludes symlinks outside archive: ' + cli.stdout)
            recording_id = db.execute('SELECT id FROM recordings').fetchone()[0]
        url = f'/video/{recording_id}'
        status, headers, body = request(url)
        check(status == 200 and body == mp4, 'Full recording bytes delivered intact')
        check(headers['Cache-Control'] == 'private, no-store', 'Footage must not be cached')
        status, headers, body = request(url, headers={'Range': 'bytes=0-23'})
        check(status == 206 and body == mp4[:24] and headers['Content-Range'] == f'bytes 0-23/{len(mp4)}', 'Initial byte range correct')
        check(request(url, headers={'Range': 'bytes=-12'})[2] == mp4[-12:], 'Suffix range correct')
        status, headers, body = request(url, 'HEAD', {'Range': 'bytes=8-15'})
        check(status == 206 and body == b'' and headers['Content-Length'] == '8', 'HEAD range headers correct, without payload')
        for value in ['bytes=999999-', 'bytes=20-10', 'bytes=-0', 'bytes=0-1,4-5']:
            check(request(url, headers={'Range': value})[0] == 416, 'Invalid/unsupported range refused: ' + value)
        check(request(f'/api/recordings/{recording_id}/thumbnail')[2] == thumbnail.read_bytes(), 'Authenticated thumbnail delivered')
        check(request('/api/search?limit=10')[0] == 200, 'Search with SQLite LIMIT works')
        check(request('/api/recordings?limit=10')[0] == 200, 'Recording list with SQLite LIMIT works')
        with sqlite3.connect(tmp / 'data/ctv.sqlite') as db:
            stamp = db.execute('SELECT start_ts FROM recordings WHERE id=?', (recording_id,)).fetchone()[0]
        offset_body = {'name': 'Camera', 'source_path': str(camera), 'time_offset_seconds': 60}
        check(request(f'/api/cameras/{camera_id}', 'PUT', {'X-CTV-Request': '1'}, offset_body)[0] == 200, 'Camera time correction can be updated')
        for endpoint in ['/api/search', '/api/recordings']:
            status, _, body = request(f'{endpoint}?from={stamp+50}&to={stamp+90}')
            rows = json.loads(body)
            check(status == 200 and len(rows) == 1 and rows[0]['start_ts'] == stamp+60, f'{endpoint} filters corrected timestamps numerically')
        offset_body['time_offset_seconds'] = 0
        check(request(f'/api/cameras/{camera_id}', 'PUT', {'X-CTV-Request': '1'}, offset_body)[0] == 200, 'Time correction does not reset recording metadata')
        check(request('/api/timeline?from=1e309&to=2e309')[0] == 422, 'Nonfinite timeline range refused')
        invalid = subprocess.run([PHP, str(ROOT / 'ctv_php/bin/index.php'), '--date=2026-02-31'], env=env, capture_output=True)
        check(invalid.returncode != 0, 'Invalid calendar date must fail the CLI')
        failed = subprocess.run([PHP, str(ROOT / 'ctv_php/bin/index.php'), '--date=2026-10-01'], env=env, capture_output=True)
        check(failed.returncode != 0, 'Unsafe source partition must fail the CLI')
        status, _, body = request('/api/timeline/prepare?from=1790719200&to=1790892000', 'POST', {'X-CTV-Request': '1'})
        check(status == 202 and json.loads(body)['failed_partitions'] == 1, 'Failed partition does not suppress successful date preparation')
        status, _, body = request('/api/timeline?from=1790719200&to=1790892000')
        timeline = json.loads(body)
        check(status == 200 and timeline['cameras'][0]['partition_status'] == 'error' and len(timeline['cameras'][0]['segments']) == 1, 'Timeline retains healthy footage and reports partition failure: ' + json.dumps(timeline))
        # A stored path or a file replaced by a symlink is checked again at delivery.
        video.unlink()
        video.symlink_to(outside)
        check(request(url)[0] == 404, 'Video replaced with an external symlink is refused')
        thumbnail.unlink()
        thumbnail.symlink_to(outside)
        check(request(f'/api/recordings/{recording_id}/thumbnail')[0] == 404, 'Thumbnail replaced with external symlink is refused')
        video.unlink()
        video.write_bytes(mp4)
        thumbnail.unlink()
        thumbnail.write_bytes(b'\xff\xd8\xff\xd9')
        # Exercise duration patches and ranges splitting a patched duration field.
        fragmented = (box('ftyp', b'isom' + b'\0' * 12) + box('moov',
            box('mvhd', header([0, 0, 1000, 0], 80)) +
            box('trak', box('tkhd', header([0, 0, 1, 0, 0], 64)) + box('mdia', box('mdhd', header([0, 0, 1000, 0, 0])))) +
            box('mvex', box('trex', header([1, 1, 100, 0, 0])))) +
            box('moof', box('traf', box('tfhd', header([1])) + box('trun', header([10])))) + box('mdat', b'\0' * 16))
        video.write_bytes(fragmented)
        with sqlite3.connect(tmp / 'data/ctv.sqlite') as db:
            db.execute('UPDATE recordings SET duration=1 WHERE id=?', (recording_id,))
        status, _, patched = request(url)
        field = fragmented.index(b'mvhd') + 20
        check(status == 200 and len(patched) == len(fragmented) and patched[field:field+4] == struct.pack('>I', 1000), 'Fragmented duration patched without changing file length')
        status, _, split = request(url, headers={'Range': f'bytes={field+1}-{field+2}'})
        check(status == 206 and split == patched[field+1:field+3], 'Range cutting through a duration patch is correct')
        check(video.read_bytes() == fragmented, 'Streaming does not change original footage')
        # Failed metadata deletion must not partially change camera configuration.
        other_source = archive / 'Other'
        other_source.mkdir()
        with sqlite3.connect(tmp / 'data/ctv.sqlite') as db:
            db.execute("CREATE TRIGGER fail_delete BEFORE DELETE ON recordings BEGIN SELECT RAISE(ABORT, 'test deletion failure'); END")
        check(request(f'/api/cameras/{camera_id}', 'PUT', {'X-CTV-Request': '1'}, {'name': 'Changed', 'source_path': str(other_source)})[0] == 500, 'Injected camera update failure returned')
        with sqlite3.connect(tmp / 'data/ctv.sqlite') as db:
            check(db.execute('SELECT source_path FROM cameras WHERE id=?', (camera_id,)).fetchone()[0] == str(camera), 'Camera configuration rolled back with failed metadata reset')
            db.execute('DROP TRIGGER fail_delete')
        bad_source = archive / 'Offline'
        bad_source.mkdir()
        status, _, body = request('/api/cameras', 'POST', {'X-CTV-Request': '1'}, {'name': 'AAA offline', 'source_path': str(bad_source), 'indexing_mode': 'full'})
        check(status == 201, 'Second camera configured for failed-scan isolation')
        bad_id = json.loads(body)['id']
        bad_source.rmdir()
        status, _, body = request('/api/scan', 'POST', {'X-CTV-Request': '1'})
        result = json.loads(body)
        check(status == 200 and result['cameras'] == 1 and result['failed_cameras'] == [bad_id], 'A failed camera must not stop scanning the other cameras')
        check(request(f'/api/cameras/{camera_id}', 'DELETE', {'X-CTV-Request': '1'})[0] == 200, 'Authenticated camera deletion works')
        with sqlite3.connect(tmp / 'data/ctv.sqlite') as db:
            check(db.execute('SELECT COUNT(*) FROM recordings').fetchone()[0] == 0, 'Camera deletion cascades to recordings')

    with server(tmp, dict(env, CTV_PHP_ADMIN='0'), '/viewer') as request:
        status, _, body = request('/api/session')
        session = json.loads(body)
        check(status == 200 and not session['is_admin'] and session['source_roots'] == [], 'Read-only session works under a subdirectory')
        for path, method in [('/api/cameras', 'POST'), ('/api/scan', 'POST'), ('/api/cameras/1', 'PUT'), ('/api/cameras/1', 'DELETE'), ('/api/admin/rebuild-index', 'POST')]:
            check(request(path, method, {'X-CTV-Request': '1'})[0] == 403, f'Read-only mode denies {method} {path}')
        check(request('/')[0] == 200 and request('/js/app.js')[0] == 200, 'Subdirectory frontend routes work')

print(f'PHP HTTP integration tests passed ({checks} checks)')
