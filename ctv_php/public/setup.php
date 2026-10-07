<?php

declare(strict_types=1);

require_once dirname(__DIR__) . '/src/Setup.php';

use CtvPhp\Setup;

ini_set('display_errors', '0');
header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: private, no-store');
header('Referrer-Policy: no-referrer');
header('X-Content-Type-Options: nosniff');
header("Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");

function escape(string $value): string
{
    return htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

function page(string $content): never
{
    echo '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CCTV Viewer PHP setup</title><style>'
        . 'body{font:16px/1.5 system-ui,sans-serif;margin:0;background:#f3f5f7;color:#1e293b}main{max-width:760px;margin:2rem auto;padding:2rem;background:white;border-radius:12px}h1{margin-top:0}fieldset{border:1px solid #cbd5e1;border-radius:8px;margin:1.5rem 0;padding:1rem}legend{font-weight:650}label{display:block;margin:.8rem 0 .2rem}input,textarea,select,button{font:inherit;box-sizing:border-box}input:not([type=checkbox]),textarea,select{width:100%;padding:.5rem;border:1px solid #94a3b8;border-radius:5px}small{display:block;color:#475569;margin:.2rem 0}button{border:0;border-radius:6px;background:#1d4ed8;color:white;padding:.6rem 1rem;cursor:pointer}.error{padding:1rem;background:#fff1f2;border:1px solid #e11d48;border-radius:6px}code{overflow-wrap:anywhere}a{color:#1d4ed8}@media(max-width:800px){main{margin:0;border-radius:0;padding:1rem}}'
        . '</style></head><body><main><h1>CCTV Viewer PHP setup</h1>' . $content . '</main></body></html>';
    exit;
}

$setup = new Setup(dirname(__DIR__));
$script = $_SERVER['SCRIPT_NAME'] ?? '/setup.php';
$viewer = rtrim(str_replace('\\', '/', dirname($script)), '/') . '/';
try {
    $https = (!empty($_SERVER['HTTPS']) && strtolower((string) $_SERVER['HTTPS']) !== 'off') || ($_SERVER['SERVER_PORT'] ?? '') === '443';
    $localDevelopment = PHP_SAPI === 'cli-server' && in_array($_SERVER['REMOTE_ADDR'] ?? '', ['127.0.0.1', '::1'], true);
    if (!$https && !$localDevelopment) {
        http_response_code(400);
        page('<p>Enable HTTPS on this domain, then open this page over HTTPS before entering the setup token or passwords.</p>');
    }
    if (realpath($_SERVER['DOCUMENT_ROOT'] ?? '') !== realpath($setup->baseDir . '/public')) {
        http_response_code(400);
        page('<p>Set this site’s document root to <code>ctv_php/public</code> in the hosting control panel. The rest of the repository must stay private.</p>');
    }
    if ($setup->configured()) {
        http_response_code(410);
        page('<p>Setup is closed because <code>ctv_php/config.php</code> already exists. To change settings, run <code>php ctv_php/setup.php</code> in the repository root or edit that private file.</p><p><a href="' . escape($viewer) . '">Open the viewer</a></p>');
    }
    $setup->checkRequirements();
    $token = $setup->webToken();
    session_name('ctv_setup');
    if (!@session_start([
        'use_strict_mode' => 1, 'use_only_cookies' => 1,
        'cookie_secure' => $https, 'cookie_httponly' => true,
        'cookie_samesite' => 'Strict', 'cookie_path' => $viewer,
    ])) {
        throw new RuntimeException('PHP sessions must be writable. Use php ctv_php/setup.php instead.');
    }
    $_SESSION['csrf'] ??= bin2hex(random_bytes(32));
    $authorized = isset($_SESSION['token_hash']) && hash_equals(hash('sha256', $token), $_SESSION['token_hash']);
    $error = '';
    $config = $setup->defaults();
    $values = array_replace($config, ['source_roots' => implode("\n", $config['source_roots']), 'username' => 'alex', 'discover' => '1']);
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if (!in_array($method, ['GET', 'POST'], true)) {
        header('Allow: GET, POST');
        http_response_code(405);
        page('<p>Use GET to open the wizard or POST to submit it.</p>');
    }
    if ($method === 'POST') {
        if (!is_string($_POST['csrf'] ?? null) || !hash_equals($_SESSION['csrf'], $_POST['csrf']) || ($_SERVER['HTTP_SEC_FETCH_SITE'] ?? '') === 'cross-site') {
            http_response_code(403);
            page('<p>The setup session expired or the request came from another site. Reload the wizard and try again.</p>');
        }
        if (!$authorized) {
            if (is_string($_POST['token'] ?? null) && hash_equals($token, trim($_POST['token']))) {
                session_regenerate_id(true);
                $_SESSION['token_hash'] = hash('sha256', $token);
                $_SESSION['csrf'] = bin2hex(random_bytes(32));
                header('Location: ' . $script, true, 303);
                exit;
            }
            http_response_code(403);
            $error = 'The setup token did not match. Copy it from ctv_php/.setup-token in the hosting file manager.';
        } else {
            try {
                foreach (array_keys($config) as $key) {
                    if (!is_string($_POST[$key] ?? null)) {
                        throw new RuntimeException('Missing or invalid setting: ' . $key);
                    }
                    $values[$key] = $_POST[$key];
                }
                if (!is_string($_POST['username'] ?? null)) {
                    throw new RuntimeException('Enter a login username.');
                }
                $values['username'] = $_POST['username'];
                $values['discover'] = ($_POST['discover'] ?? '') === '1' ? '1' : '0';
                $config = $setup->validate($values);
                $password = $_POST['password'] ?? null;
                if (!is_string($password) || !is_string($_POST['confirmation'] ?? null) || $password !== $_POST['confirmation']) {
                    throw new RuntimeException('Enter matching passwords in both password fields.');
                }
                $setup->save($config, $values['username'], $password, null);
                unset($password, $_POST['password'], $_POST['confirmation']);
                $_SESSION = [];
                session_destroy();
                $discovery = '';
                if ($values['discover'] === '1') {
                    try {
                        $discovery = '<p>Discovered ' . $setup->discover($config) . ' new camera(s). Review their timezone and folder pattern in Cameras.</p>';
                    } catch (Throwable $failure) {
                        $discovery = '<p class="error">Settings saved, but discovery failed: ' . escape($failure->getMessage()) . '. Retry from the Cameras view or run <code>php ctv_php/bin/index.php --discover</code>.</p>';
                    }
                }
                page('<h2>Setup complete</h2><p>Your configuration and bcrypt password file were saved outside the document root. The setup token was removed and the browser wizard is now closed.</p>' . $discovery
                    . '<p><a href="' . escape($viewer) . '">Open the viewer and sign in</a> with the username and password you chose. Add or adjust cameras in Cameras, then select a date to index and view its recordings.</p>'
                    . '<p>To index all existing dates, run <code>php ctv_php/bin/index.php --all</code>. Use <code>--days=2</code> for incremental cron scans. See <code>ctv_php/README.md</code> for deployment checks.</p>');
            } catch (RuntimeException $failure) {
                http_response_code(400);
                $error = $failure->getMessage();
            }
        }
    }
    $content = $error !== '' ? '<p class="error">' . escape($error) . '</p>' : '';
    $content .= '<form method="post"><input type="hidden" name="csrf" value="' . escape($_SESSION['csrf']) . '">';
    if (!$authorized) {
        page($content . '<h2>1. Unlock installation</h2><p>In your hosting file manager, open the private file <code>ctv_php/.setup-token</code> and copy its contents. It was created when you opened this page. Enable “show hidden files” if needed.</p>'
            . '<p>This proves you control the hosting account before the wizard can configure access to footage. The token is never displayed here.</p><label for="token">One-time setup token</label><input id="token" name="token" type="password" required autocomplete="off">'
            . '<p><button>Continue</button></p></form><p>If the hosting account has SSH, you can instead run <code>php ctv_php/setup.php</code> from the repository root.</p>');
    }
    $content .= '<p>PHP and SQLite requirements passed. Complete the settings below; all paths must be absolute server filesystem paths. Archives must be outside every public document root.</p><fieldset><legend>2. Archive and storage</legend>'
        . '<label for="source_roots">Archive directories</label><textarea id="source_roots" name="source_roots" rows="3" required>' . escape((string) $values['source_roots']) . '</textarea><small>One directory per line: either a parent containing cameras, e.g. /home/USER/reolink-backup, or a camera itself, e.g. /home/USER/reolink-backup/Wand1.</small>';
    $fields = [
        'data_dir' => ['Private writable SQLite directory', 'The wizard creates this directory if needed.'],
        'web_root' => ['Shared frontend directory', 'The ctv_web folder from the complete repository.'],
        'timezone' => ['Default camera timezone', 'For example Europe/Zurich, America/New_York or UTC.'],
        'file_settle_seconds' => ['Upload settle time (seconds)', 'Ignore MP4s modified more recently than this.'],
        'snapshot_max_distance_seconds' => ['Thumbnail matching distance (seconds)', 'Maximum time between a recording and its uploaded JPEG.'],
        'password_file' => ['Private bcrypt password file', 'The parent directory must exist; keep this outside public and ctv_web. Existing users will be kept.'],
    ];
    foreach ($fields as $key => [$label, $hint]) {
        $numeric = str_ends_with($key, '_seconds');
        $content .= '<label for="' . $key . '">' . $label . '</label><input id="' . $key . '" name="' . $key . '" ' . ($numeric ? 'type="number" min="0" step="1"' : 'type="text"') . ' required value="' . escape((string) $values[$key]) . '"><small>' . $hint . '</small>';
    }
    $admin = filter_var($values['admin'], FILTER_VALIDATE_BOOLEAN);
    $content .= '</fieldset><fieldset><legend>3. Password protection and permissions</legend><label for="username">Login username</label><input id="username" name="username" required maxlength="64" value="' . escape((string) $values['username']) . '" autocomplete="username">'
        . '<label for="password">Password</label><input id="password" name="password" type="password" required minlength="12" autocomplete="new-password"><small>12–72 bytes. Passwords are stored only as bcrypt hashes. No default password is supplied.</small>'
        . '<label for="confirmation">Confirm password</label><input id="confirmation" name="confirmation" type="password" required minlength="12" autocomplete="new-password">'
        . '<label for="admin">Permissions for all authenticated users</label><select id="admin" name="admin"><option value="1"' . ($admin ? ' selected' : '') . '>View and administer cameras</option><option value="0"' . (!$admin ? ' selected' : '') . '>View only (camera configuration is read only)</option></select><small>All users share this role. Use administrator access until camera configuration is complete.</small></fieldset>'
        . '<fieldset><legend>4. Finish installation</legend><label><input name="discover" type="checkbox" value="1"' . ($values['discover'] === '1' ? ' checked' : '') . '> Discover cameras automatically</label><small>Accepts CAMERA/YYYY/MM/DD and direct camera roots containing YYYY/MM/DD. Other layouts can be configured in Cameras. This does not scan the video files.</small></fieldset>'
        . '<p><button>Save settings and enable password protection</button></p></form><p>The browser wizard closes after saving. Keep the data directory and password file readable by the website’s PHP account; cron must use the same configuration.</p>';
    page($content);
} catch (Throwable $error) {
    http_response_code(500);
    page('<p class="error">' . escape($error->getMessage()) . '</p><p>Alternatively, run <code>php ctv_php/setup.php</code> in the repository root. Installation instructions: <code>ctv_php/README.md</code>.</p>');
}
