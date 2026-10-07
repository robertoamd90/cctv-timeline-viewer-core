"""Install isolated repository copies through the real CLI and browser wizard."""
import base64
import contextlib
import hashlib
import http.client
from http.cookies import SimpleCookie
import json
import os
from pathlib import Path
import re
import select
import shutil
import socket
import sqlite3
import subprocess
import signal
import tempfile
import time
from urllib.parse import urlencode

ROOT = Path(__file__).resolve().parents[2]
PHP = os.environ.get('PHP_BIN') or shutil.which('php')
assert PHP, 'Set PHP_BIN to a PHP CLI with pdo_sqlite'
PASSWORD = 'setup-test-only-password'
REPLACEMENT = 'replacement-test-password'
checks = 0


def check(condition, message):
    global checks
    checks += 1
    assert condition, message


def fixture(folder):
    app = folder / 'app'
    app.mkdir()
    shutil.copytree(ROOT / 'ctv_php', app / 'ctv_php', ignore=shutil.ignore_patterns('config.php', '.htpasswd*', '.setup*', 'var', '__pycache__'))
    shutil.copytree(ROOT / 'ctv_web', app / 'ctv_web')
    archive = folder / "archive's recordings"
    (archive / 'Camera/2026/10/06').mkdir(parents=True)
    return app, archive


def run_php(app, arguments, text=None, env=None):
    return subprocess.run([PHP, *arguments], cwd=app, input=text, capture_output=True, text=True, env=env, timeout=20)


def config(app):
    result = run_php(app, ['-r', 'echo json_encode(require "ctv_php/config.php");'])
    check(result.returncode == 0, 'Generated config is valid executable PHP: ' + result.stderr)
    return json.loads(result.stdout)


def verify_password(app, username, password):
    code = 'foreach (file("ctv_php/.htpasswd", FILE_IGNORE_NEW_LINES) as $line) { [$u, $h] = explode(":", $line, 2); if ($u === $argv[1]) { exit(password_verify($argv[2], $h) ? 0 : 1); }} exit(2);'
    return run_php(app, ['-r', code, username, password]).returncode == 0


def answers(archive, *, update=False, role='y', change=None, discover='y', save='y'):
    values = (['y'] if update else []) + [str(archive), '', '', 'UTC', '0', '120', role, '']
    if update:
        values += ['y' if change else 'n']
    if not update or change:
        values += ['', change or PASSWORD, change or PASSWORD]
    return '\n'.join(values + [discover, save]) + '\n'


def core(app, action, values, **extra):
    script = app / 'setup_test.php'
    script.write_text('<?php require __DIR__ . "/ctv_php/src/Setup.php"; $s = new CtvPhp\\Setup(__DIR__ . "/ctv_php"); $input = json_decode(stream_get_contents(STDIN), true); try { '
                      'if ($input["action"] === "validate") { echo json_encode($s->validate($input["values"])); } '
                      'else { $s->save($input["values"], $input["username"], $input["password"], array_key_exists("expected", $input) ? $input["expected"] : $s->configurationHash()); } '
                      '} catch (Throwable $e) { fwrite(STDERR, $e->getMessage()); exit(1); }')
    return run_php(app, [str(script)], json.dumps(dict(action=action, values=values, **extra)))


@contextlib.contextmanager
def server(app, *, remote=False, document_root=None):
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    router = app / 'router.php'
    overrides = ''
    if remote:
        overrides += '$_SERVER["REMOTE_ADDR"] = "192.0.2.1"; '
    if document_root:
        overrides += '$_SERVER["DOCUMENT_ROOT"] = ' + json.dumps(str(document_root)) + '; '
    router.write_text('<?php ' + overrides + '$setup = parse_url($_SERVER["REQUEST_URI"], PHP_URL_PATH) === "/setup.php"; '
                      '$_SERVER["SCRIPT_NAME"] = $setup ? "/setup.php" : "/index.php"; '
                      'require __DIR__ . ($setup ? "/ctv_php/public/setup.php" : "/ctv_php/public/index.php");')
    sessions = app / 'test-sessions'
    sessions.mkdir()
    with (app / 'server.log').open('w+') as log:
        process = subprocess.Popen([PHP, '-d', 'session.save_path=' + str(sessions), '-S', f'127.0.0.1:{port}', '-t', str(app / 'ctv_php/public'), str(router)], stdout=log, stderr=log)
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
                raise AssertionError('PHP setup test server did not start')

            cookies = {}

            def request(path='/setup.php', method='GET', body=None, headers=None):
                sent = dict(headers or {})
                if cookies:
                    sent['Cookie'] = '; '.join(k + '=' + v for k, v in cookies.items())
                if isinstance(body, dict):
                    body = urlencode(body)
                    sent['Content-Type'] = 'application/x-www-form-urlencoded'
                connection = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
                connection.request(method, path, body=body, headers=sent)
                response = connection.getresponse()
                received = dict(response.getheaders())
                parsed = SimpleCookie()
                parsed.load(received.get('Set-Cookie', ''))
                cookies.update({key: value.value for key, value in parsed.items()})
                result = response.status, received, response.read().decode()
                connection.close()
                return result

            yield request, cookies
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


def csrf(html):
    return re.search(r'name="csrf" value="([a-f0-9]+)"', html)[1]


def terminal(app, archive, interrupt=False):
    import pty
    import termios
    master, slave = pty.openpty()
    process = subprocess.Popen([PHP, 'ctv_php/setup.php'], cwd=app, stdin=slave, stdout=slave, stderr=slave)
    transcript = bytearray()
    pending = bytearray()

    def until(marker):
        deadline = time.monotonic() + 5
        while marker.encode() not in pending:
            assert time.monotonic() < deadline, (marker, bytes(transcript))
            if select.select([master], [], [], .1)[0]:
                part = os.read(master, 65536)
                transcript.extend(part)
                pending.extend(part)
        del pending[:pending.index(marker.encode()) + len(marker)]

    prompts = [('Archive directories', str(archive)), ('Private writable SQLite', ''),
               ('Shared frontend', ''), ('Default camera timezone', 'UTC'), ('Seconds to wait', ''),
               ('Maximum thumbnail', ''), ('Allow all authenticated', ''), ('Private bcrypt', ''),
               ('Login username', ''), ('Password (', PASSWORD), ('Confirm password', PASSWORD),
               ('Discover cameras', 'n'), ('Save configuration', 'n')]
    try:
        for marker, value in prompts:
            until(marker)
            if marker in ['Password (', 'Confirm password']:
                check(not termios.tcgetattr(slave)[3] & termios.ECHO, 'Disable terminal echo before the password prompt')
                if interrupt:
                    process.send_signal(signal.SIGINT)
                    break
            os.write(master, (value + '\n').encode())
        process.wait(timeout=5)
        while select.select([master], [], [], .1)[0]:
            transcript.extend(os.read(master, 65536))
        check(PASSWORD.encode() not in transcript, 'Terminal does not echo passwords')
        check(termios.tcgetattr(slave)[3] & termios.ECHO, 'Terminal echo is restored after input or cancellation')
        check(process.returncode == (1 if interrupt else 0) and not (app / 'ctv_php/config.php').exists(), 'Terminal cancellation preserves an unconfigured installation')
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)
        os.close(slave)


with tempfile.TemporaryDirectory(prefix='ctv_setup_') as temporary:
    tmp = Path(temporary)
    cli_folder = tmp / 'cli'
    cli_folder.mkdir()
    app, archive = fixture(cli_folder)
    result = run_php(app, ['ctv_php/setup.php', '--help'])
    check(result.returncode == 0 and not (app / 'ctv_php/config.php').exists(), 'Help does not install anything')
    result = run_php(app, ['ctv_php/setup.php'], answers(archive))
    check(result.returncode == 0 and 'Setup complete' in result.stdout, 'CLI installs: ' + result.stderr)
    check(PASSWORD not in result.stdout + result.stderr, 'CLI output never prints the chosen password')
    saved = config(app)
    check(saved['source_roots'] == [str(archive)] and saved['timezone'] == 'UTC', 'Archive path with quotes and timezone are safely saved')
    check(saved['admin'] is True and saved['file_settle_seconds'] == 0 and saved['snapshot_max_distance_seconds'] == 120, 'All timing and role settings are saved with the proper types')
    check(verify_password(app, 'alex', PASSWORD), 'Default example username alex has a working bcrypt login')
    check(not verify_password(app, 'alex', 'wrong'), 'Wrong password fails after setup')
    for name in ['config.php', '.htpasswd']:
        check((app / 'ctv_php' / name).stat().st_mode & 0o007 == 0, name + ' is not accessible to other filesystem users')
    check(PASSWORD not in (app / 'ctv_php/config.php').read_text() + (app / 'ctv_php/.htpasswd').read_text(), 'Only a password hash is stored')
    with sqlite3.connect(saved['data_dir'] + '/ctv.sqlite') as db:
        check(db.execute('SELECT name, timezone FROM cameras').fetchall() == [('Camera', 'UTC')], 'Setup discovers camera folders without scanning footage')
    before = {name: (app / 'ctv_php' / name).read_bytes() for name in ['config.php', '.htpasswd']}
    result = run_php(app, ['ctv_php/setup.php'], '\n')
    check(result.returncode == 0 and all((app / 'ctv_php' / name).read_bytes() == data for name, data in before.items()), 'Declining an existing-install update preserves config and passwords')
    result = run_php(app, ['ctv_php/setup.php'], answers(archive, update=True, role='n', discover='n'))
    check(result.returncode == 0 and config(app)['admin'] is False, 'CLI can make an existing installation read only')
    check((app / 'ctv_php/.htpasswd').read_bytes() == before['.htpasswd'], 'Retaining credentials leaves the password file unchanged')
    additional = run_php(app, ['-r', 'echo "sam:" . password_hash("setup-test-only-password", PASSWORD_BCRYPT, ["cost"=>4]) . "\n";']).stdout
    with (app / 'ctv_php/.htpasswd').open('a') as file:
        file.write(additional)
    result = run_php(app, ['ctv_php/setup.php'], answers(archive, update=True, change=REPLACEMENT, discover='n'))
    check(result.returncode == 0 and verify_password(app, 'alex', REPLACEMENT) and not verify_password(app, 'alex', PASSWORD), 'CLI changes an existing user password')
    check(verify_password(app, 'sam', PASSWORD), 'Changing a password retains other users')
    saved = config(app)
    second_archive = cli_folder / 'second archive'
    second_archive.mkdir()
    multiple = dict(saved, source_roots=f'{archive};\n\n{second_archive}\n')
    result = core(app, 'validate', multiple)
    check(result.returncode == 0 and json.loads(result.stdout)['source_roots'] == [str(archive), str(second_archive)], 'Multiple archive paths and blank lines are accepted')
    for key, value in [('data_dir', str(app / 'ctv_php/public/data')), ('password_file', str(app / 'ctv_web/js/passwords.txt')),
                       ('source_roots', [str(app)]), ('source_roots', [str(cli_folder / 'missing')]),
                       ('source_roots', []), ('web_root', str(archive)), ('timezone', 'Invalid/Timezone'),
                       ('file_settle_seconds', -1), ('snapshot_max_distance_seconds', '1.5'), ('admin', 'maybe')]:
        check(core(app, 'validate', dict(saved, **{key: value})).returncode != 0, 'Reject invalid setting: ' + key + '=' + str(value))
    link = cli_folder / 'linked-public'
    link.symlink_to(app / 'ctv_php/public', target_is_directory=True)
    check(core(app, 'validate', dict(saved, data_dir=str(link / 'new-data'))).returncode != 0, 'A symlink to the public directory cannot hide private storage')
    for password in ['', 'short', 'x' * 73]:
        check(core(app, 'save', saved, username='alex', password=password).returncode != 0, 'Reject unsafe bcrypt password length ' + str(len(password)))
    check(core(app, 'save', saved, username='bad:user', password=PASSWORD).returncode != 0, 'Reject htpasswd record injection')
    unrelated = cli_folder / 'unrelated.php'
    unrelated.write_text('<?php echo "other file";')
    result = core(app, 'save', dict(saved, password_file=str(unrelated)), username='alex', password=PASSWORD)
    check(result.returncode != 0 and unrelated.read_text() == '<?php echo "other file";', 'Never overwrite an unrelated file selected as the password file')
    overrides = dict(os.environ, CTV_PHP_ADMIN='0')
    result = run_php(app, ['ctv_php/setup.php'], env=overrides)
    check(result.returncode != 0 and 'CTV_PHP_ADMIN' in result.stderr, 'Conflicting environment overrides are explained before setup')
    before = {name: (app / 'ctv_php' / name).read_bytes() for name in ['config.php', '.htpasswd']}
    result = core(app, 'save', saved, username='alex', password=PASSWORD, expected='stale-configuration')
    check(result.returncode != 0 and all((app / 'ctv_php' / name).read_bytes() == data for name, data in before.items()), 'Concurrent configuration changes abort without replacing settings or credentials')
    rollback = app / 'rollback_test.php'
    rollback.write_text('<?php namespace CtvPhp; function rename($source, $target) { return basename($target) === "config.php" ? false : \\rename($source, $target); } '
                        'require __DIR__ . "/ctv_php/src/Setup.php"; $s = new Setup(__DIR__ . "/ctv_php"); '
                        'try { $s->save($s->defaults(), "alex", "rollback-test-password", $s->configurationHash()); } catch (\\Throwable $e) { exit(1); }')
    result = run_php(app, [str(rollback)])
    check(result.returncode != 0 and all((app / 'ctv_php' / name).read_bytes() == data for name, data in before.items()), 'A failed configuration install restores the original credentials')
    check(not list((app / 'ctv_php').glob('.ctv-setup-*')), 'Failed setup cleans up staged files and backups after successful rollback')

    web_folder = tmp / 'web'
    web_folder.mkdir()
    app, archive = fixture(web_folder)
    password_file = app / 'ctv_php/.htpasswd'
    password_file.write_text(additional)
    with server(app) as (request, cookies):
        status, headers, html = request()
        check(status == 200 and 'Unlock installation' in html, f'Browser starts with a token gate: {status} {html}')
        token = (app / 'ctv_php/.setup-token').read_text().strip()
        check(len(token) == 64 and token not in html and str(archive) not in html, 'Setup token and private settings are never sent to unauthenticated visitors')
        check((app / 'ctv_php/.setup-token').stat().st_mode & 0o077 == 0, 'Setup token is private to the hosting account')
        check('no-store' in headers['Cache-Control'] and 'HttpOnly' in headers['Set-Cookie'] and 'SameSite=Strict' in headers['Set-Cookie'], 'Setup responses and cookies protect private data')
        login = {'csrf': csrf(html), 'token': 'wrong'}
        check(request(method='POST', body=login)[0] == 403, 'Incorrect setup token cannot unlock settings')
        check(request(method='POST', body={'csrf': 'wrong', 'token': token})[0] == 403, 'Token submissions require a matching CSRF token')
        initial_cookie = cookies['ctv_setup']
        check(request(method='POST', body={'csrf': csrf(html), 'token': token})[0] == 303, 'Correct private token unlocks setup')
        check(cookies['ctv_setup'] != initial_cookie, 'Unlocking setup changes the session id')
        status, _, html = request()
        check(status == 200 and 'Archive and storage' in html and 'value="alex"' in html, 'Authenticated setup form uses the common example username')
        values = {'csrf': csrf(html), 'source_roots': str(archive), 'data_dir': str(app / 'ctv_php/var'),
                  'web_root': str(app / 'ctv_web'), 'timezone': 'UTC', 'file_settle_seconds': '30',
                  'snapshot_max_distance_seconds': '90', 'password_file': str(password_file), 'admin': '0',
                  'username': 'alex', 'password': PASSWORD, 'confirmation': PASSWORD, 'discover': '1'}
        check(request(method='POST', body=values, headers={'Sec-Fetch-Site': 'cross-site'})[0] == 403, 'Cross-site install requests are rejected')
        status, _, html = request(method='POST', body=dict(values, confirmation='different'))
        check(status == 400 and PASSWORD not in html and not (app / 'ctv_php/config.php').exists(), 'Password mismatch leaves installation untouched and does not reflect secrets')
        check(request(method='POST', body=dict(values, password='x' * 73, confirmation='x' * 73))[0] == 400, 'Browser rejects passwords that bcrypt would truncate')
        check(request(method='POST', body=dict(values, data_dir=str(app / 'ctv_php/public/data')))[0] == 400, 'Browser rejects public private-file locations')
        malformed = dict(values)
        del malformed['admin']
        check(request(method='POST', body=malformed)[0] == 400, 'Browser requires every configuration field')
        check(request(method='POST', body=urlencode(values) + '&admin%5B%5D=1', headers={'Content-Type': 'application/x-www-form-urlencoded'})[0] == 400, 'Array-valued form fields cannot bypass validation')
        check(not (app / 'ctv_php/config.php').exists(), 'All rejected requests leave the config absent')
        status, _, html = request(method='POST', body=values)
        check(status == 200 and 'Setup complete' in html and PASSWORD not in html, 'Browser saves valid settings without displaying the password')
        check(not (app / 'ctv_php/.setup-token').exists(), 'One-time token is removed after setup')
        check(verify_password(app, 'alex', PASSWORD) and verify_password(app, 'sam', PASSWORD), 'Browser creates a bcrypt login and retains existing users')
        saved = config(app)
        check(saved['admin'] is False and saved['source_roots'] == [str(archive)], 'Browser persists the requested configuration')
        installed = {name: hashlib.sha256((app / 'ctv_php' / name).read_bytes()).hexdigest() for name in ['config.php', '.htpasswd']}
        check(request()[0] == 410 and request(method='POST', body=values)[0] == 410, 'Browser installer is closed after installation for GET and POST')
        check(all(hashlib.sha256((app / 'ctv_php' / name).read_bytes()).hexdigest() == digest for name, digest in installed.items()), 'Rerunning browser setup cannot change config or credentials')
        check(request('/api/session')[0] == 401, 'Installed viewer still requires credentials')
        auth = {'Authorization': 'Basic ' + base64.b64encode(('alex:' + PASSWORD).encode()).decode()}
        status, _, data = request('/api/session', headers=auth)
        check(status == 200 and json.loads(data)['user']['name'] == 'alex' and not json.loads(data)['is_admin'], 'Generated credentials work with the real viewer and requested role')
        check(request('/api/cameras', method='POST', body={}, headers=dict(auth, **{'X-CTV-Request': '1'}))[0] == 403, 'Read-only setup prevents camera administration')
        with sqlite3.connect(saved['data_dir'] + '/ctv.sqlite') as db:
            check(db.execute('SELECT name FROM cameras').fetchall() == [('Camera',)], 'Browser discovery works even when the chosen viewer role is read only')
    check(PASSWORD not in (app / 'server.log').read_text(), 'Browser server logs contain no submitted passwords')

    for name, server_options in [('http', {'remote': True}), ('document-root', {'document_root': tmp})]:
        folder = tmp / name
        folder.mkdir()
        app, _ = fixture(folder)
        with server(app, **server_options) as (request, _):
            check(request()[0] == 400 and not (app / 'ctv_php/.setup-token').exists(), 'Unsafe ' + name + ' blocks installation before token creation')

    folder = tmp / 'cancel'
    folder.mkdir()
    app, archive = fixture(folder)
    result = run_php(app, ['ctv_php/setup.php'], answers(archive, discover='n', save='n'))
    check(result.returncode == 0 and not (app / 'ctv_php/config.php').exists() and not (app / 'ctv_php/.htpasswd').exists(), 'Cancelling before save creates no config or credentials')
    result = run_php(app, ['ctv_php/setup.php'], '')
    check(result.returncode != 0 and not (app / 'ctv_php/config.php').exists(), 'Unexpected end of input safely cancels installation')
    if os.name == 'posix':
        terminal(app, archive)
        has_signals = run_php(app, ['-r', 'exit(function_exists("pcntl_signal") ? 0 : 1);']).returncode == 0
        if has_signals:
            terminal(app, archive, interrupt=True)

print(f'PHP setup integration tests passed ({checks} checks)')
