<?php

declare(strict_types=1);

// The browser entry point lives in ctv_php/public, alongside the viewer.
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit('Use the setup.php inside ctv_php/public, or run php ctv_php/setup.php in a terminal.');
}

require_once __DIR__ . '/src/Setup.php';

use CtvPhp\Setup;

function ask(string $label, string $default = ''): string
{
    fwrite(STDOUT, $label . ($default !== '' ? " [$default]" : '') . ': ');
    $line = fgets(STDIN);
    if ($line === false) {
        throw new RuntimeException('Input ended; setup cancelled.');
    }
    return trim($line) === '' ? $default : trim($line);
}

function yes(string $label, bool $default): bool
{
    while (true) {
        $value = strtolower(ask($label, $default ? 'y' : 'n'));
        if (in_array($value, ['y', 'yes', 'n', 'no'], true)) {
            return in_array($value, ['y', 'yes'], true);
        }
        fwrite(STDOUT, "Enter y or n.\n");
    }
}

function secret(string $label): string
{
    $terminal = function_exists('stream_isatty') && stream_isatty(STDIN);
    $state = null;
    $handlers = [];
    $previousAsync = null;
    if ($terminal) {
        if (!function_exists('shell_exec') || !function_exists('exec')) {
            throw new RuntimeException('Cannot hide terminal input. Use the HTTPS browser wizard instead.');
        }
        $state = shell_exec('stty -g 2>/dev/null');
        if (!is_string($state) || !preg_match('/^[a-fA-F0-9:;\s-]+$/D', $state)) {
            throw new RuntimeException('Cannot hide terminal input. Use the HTTPS browser wizard instead.');
        }
        exec('stty -echo 2>/dev/null', $output, $status);
        if ($status !== 0) {
            throw new RuntimeException('Cannot hide terminal input. Use the HTTPS browser wizard instead.');
        }
    }
    try {
        if ($terminal && function_exists('pcntl_async_signals') && function_exists('pcntl_signal_get_handler') && function_exists('pcntl_signal')) {
            $previousAsync = pcntl_async_signals(true);
            foreach ([SIGINT, SIGTERM] as $signal) {
                $handlers[$signal] = pcntl_signal_get_handler($signal);
                pcntl_signal($signal, static function (): void {
                    throw new RuntimeException('Setup cancelled.');
                }, false);
            }
        }
        fwrite(STDOUT, $label . ': ');
        // Wait in short intervals so cancellation can restore echo even while
        // PHP's blocking line reader would otherwise defer a signal handler.
        if ($handlers !== []) {
            do {
                $read = [STDIN];
                $write = $except = [];
                $ready = @stream_select($read, $write, $except, 0, 200000);
                if ($ready === false) {
                    throw new RuntimeException('Cannot read terminal input; setup cancelled.');
                }
            } while ($ready !== 1);
        }
        $line = fgets(STDIN);
        if ($line === false) {
            throw new RuntimeException('Input ended; setup cancelled.');
        }
        return rtrim($line, "\r\n");
    } finally {
        if ($state !== null) {
            shell_exec('stty ' . escapeshellarg(trim($state)) . ' 2>/dev/null');
            fwrite(STDOUT, "\n");
        }
        foreach ($handlers as $signal => $handler) {
            pcntl_signal($signal, $handler);
        }
        if ($previousAsync !== null) {
            pcntl_async_signals($previousAsync);
        }
    }
}

if ($argc > 1) {
    fwrite(STDOUT, "Usage (from the repository root): php ctv_php/setup.php\nOr, from inside ctv_php: php setup.php\nInteractive configuration and bcrypt password setup.\nFor hosting without SSH, open https://YOUR-DOMAIN/setup.php with the document root set to ctv_php/public.\n");
    exit($argv[1] === '--help' ? 0 : 1);
}

try {
    $setup = new Setup(__DIR__);
    $setup->checkRequirements();
    $expected = $setup->configurationHash();
    $config = $setup->defaults();
    fwrite(STDOUT, "CCTV Timeline Viewer — PHP setup\nPress Enter to accept a default. Use absolute filesystem paths.\n\n");
    if ($expected !== null && !yes('Update the existing configuration (other password-file users are kept)', false)) {
        fwrite(STDOUT, "Setup cancelled; no settings changed.\n");
        exit(0);
    }
    while (true) {
        $config['source_roots'] = ask('Archive directories (camera folders or their parents; separate paths with ;)', implode(';', $config['source_roots']));
        $config['data_dir'] = ask('Private writable SQLite data directory', $config['data_dir']);
        $config['web_root'] = ask('Shared frontend directory', $config['web_root']);
        $config['timezone'] = ask('Default camera timezone', $config['timezone']);
        $config['file_settle_seconds'] = ask('Seconds to wait after an MP4 was modified', (string) $config['file_settle_seconds']);
        $config['snapshot_max_distance_seconds'] = ask('Maximum thumbnail timestamp distance in seconds', (string) $config['snapshot_max_distance_seconds']);
        $config['admin'] = yes('Allow all authenticated users to change cameras and run manual scans', (bool) $config['admin']);
        $config['password_file'] = ask('Private bcrypt password file', $config['password_file']);
        try {
            $config = $setup->validate($config);
            break;
        } catch (RuntimeException $error) {
            fwrite(STDERR, $error->getMessage() . "\nPlease correct the settings.\n");
            $config['source_roots'] = is_array($config['source_roots']) ? $config['source_roots'] : explode(';', $config['source_roots']);
        }
    }
    $username = '';
    $password = null;
    if (!$setup->hasUsers($config['password_file']) || yes('Add a user or change a password in the existing file', false)) {
        do {
            $username = ask('Login username', 'alex');
            $validUsername = preg_match('/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/D', $username);
            if (!$validUsername) {
                fwrite(STDERR, "Use 1–64 letters, numbers, dots, underscores or hyphens; start with a letter or number.\n");
            }
        } while (!$validUsername);
        do {
            $password = secret('Password (12–72 bytes; input is hidden in a terminal)');
            $confirmation = secret('Confirm password');
            $valid = $password === $confirmation && strlen($password) >= 12 && strlen($password) <= 72 && !str_contains($password, "\0");
            if (!$valid) {
                fwrite(STDERR, "Passwords must match and contain 12–72 bytes. Try again.\n");
            }
        } while (!$valid);
        unset($confirmation);
    }
    $discover = yes('Discover cameras from archive roots with YYYY/MM/DD partitions', true);
    fwrite(STDOUT, "\nSettings to save:\n" . json_encode($config, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n");
    if (!yes('Save configuration and password protection', true)) {
        fwrite(STDOUT, "Setup cancelled; no settings changed.\n");
        exit(0);
    }
    $setup->save($config, $username, $password, $expected);
    unset($password);
    fwrite(STDOUT, "\nSetup complete. config.php and the bcrypt password file are private.\n");
    if ($discover) {
        try {
            fwrite(STDOUT, 'Discovered ' . $setup->discover($config) . " new camera(s).\n");
        } catch (Throwable $error) {
            fwrite(STDERR, "Settings saved, but camera discovery failed: " . $error->getMessage() . "\nRetry: php ctv_php/bin/index.php --discover\n");
        }
    }
    fwrite(STDOUT, 'Set the HTTPS site document root to ' . __DIR__ . "/public\nThen open the viewer and sign in. Review camera settings before indexing.\nInitial indexing (all dates, from the repository root): php ctv_php/bin/index.php --all\nIncremental cron indexing: php ctv_php/bin/index.php --days=2\nDeployment and cron instructions: ctv_php/README.md\n");
} catch (Throwable $error) {
    fwrite(STDERR, 'Setup failed: ' . $error->getMessage() . "\n");
    exit(1);
}
