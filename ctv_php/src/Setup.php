<?php

declare(strict_types=1);

namespace CtvPhp;

use RuntimeException;

/** Shared validation and private-file installation for the CLI and web wizard. */
final class Setup
{
    public function __construct(public readonly string $baseDir)
    {
    }

    public function checkRequirements(): void
    {
        if (PHP_VERSION_ID < 80200 || PHP_INT_SIZE !== 8) {
            throw new RuntimeException('Setup requires 64-bit PHP 8.2 or later.');
        }
        if (!class_exists(\PDO::class) || !in_array('sqlite', \PDO::getAvailableDrivers(), true)) {
            throw new RuntimeException('Enable the pdo_sqlite PHP extension before running setup.');
        }
        $overrides = array_filter([
            'CTV_PHP_SOURCE_ROOTS', 'CTV_PHP_DATA_DIR', 'CTV_PHP_WEB_ROOT',
            'CTV_PHP_TIMEZONE', 'CTV_PHP_PASSWORD_FILE', 'CTV_PHP_ADMIN',
        ], static fn (string $name): bool => getenv($name) !== false && getenv($name) !== '');
        if ($overrides !== []) {
            throw new RuntimeException('Unset these environment overrides before using the wizard: ' . implode(', ', $overrides));
        }
        if (!is_writable($this->baseDir)) {
            throw new RuntimeException('PHP needs write access to ctv_php to save the configuration.');
        }
    }

    public function configured(): bool
    {
        clearstatcache(true, $this->baseDir . '/config.php');
        return file_exists($this->baseDir . '/config.php') || is_link($this->baseDir . '/config.php');
    }

    public function configurationHash(): ?string
    {
        return $this->configured() ? $this->fileHash($this->baseDir . '/config.php') : null;
    }

    public function defaults(): array
    {
        $config = require $this->baseDir . '/config.example.php';
        $config['source_roots'] = [];
        if ($this->configured()) {
            $existing = require $this->baseDir . '/config.php';
            if (!is_array($existing)) {
                throw new RuntimeException('ctv_php/config.php must return an array.');
            }
            $config = array_replace($config, $existing);
        }
        return $config;
    }

    /** Resolve symlinks even when the final directory/file has not been created. */
    private function path(string $path): string
    {
        $path = trim($path);
        if ($path === '' || preg_match('/[\x00-\x1f\x7f]/', $path) || !str_starts_with($path, DIRECTORY_SEPARATOR)) {
            throw new RuntimeException('Use absolute filesystem paths, without control characters.');
        }
        $resolved = realpath($path);
        if ($resolved !== false) {
            return $resolved;
        }
        if (in_array(basename($path), ['.', '..'], true)) {
            throw new RuntimeException('Remove . and .. from paths that do not exist yet.');
        }
        return rtrim($this->path(dirname($path)), DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . basename($path);
    }

    private static function inside(string $path, string $directory): bool
    {
        return $path === $directory || str_starts_with($path, rtrim($directory, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR);
    }

    public function validate(array $values): array
    {
        $config = [];
        foreach (['data_dir', 'web_root', 'password_file'] as $key) {
            if (!is_string($values[$key] ?? null)) {
                throw new RuntimeException('Missing setting: ' . $key);
            }
            $config[$key] = $this->path($values[$key]);
        }
        foreach (['index.html', 'style.css', 'js/app.js'] as $asset) {
            if (!is_file($config['web_root'] . '/' . $asset) || !is_readable($config['web_root'] . '/' . $asset)) {
                throw new RuntimeException('The frontend directory must contain readable index.html, style.css and js/app.js files.');
            }
        }
        $roots = $values['source_roots'] ?? [];
        if (is_string($roots)) {
            $roots = preg_split('/[;\r\n]+/', $roots, -1, PREG_SPLIT_NO_EMPTY) ?: [];
        }
        if (!is_array($roots)) {
            throw new RuntimeException('Archive directories must be filesystem paths.');
        }
        $roots = array_filter($roots, static fn ($root): bool => !is_string($root) || trim($root) !== '');
        if ($roots === []) {
            throw new RuntimeException('Enter at least one archive directory containing the camera folders.');
        }
        $config['source_roots'] = [];
        foreach ($roots as $root) {
            if (!is_string($root)) {
                throw new RuntimeException('Archive directories must be filesystem paths.');
            }
            $root = $this->path($root);
            if (!is_dir($root) || !is_readable($root)) {
                throw new RuntimeException('Archive directory is missing or unreadable: ' . $root);
            }
            $config['source_roots'][] = $root;
        }
        $config['source_roots'] = array_values(array_unique($config['source_roots']));
        $public = realpath($this->baseDir . '/public');
        if ($public === false) {
            throw new RuntimeException('Upload the complete repository, including ctv_php/public.');
        }
        foreach ([$config['data_dir'], $config['password_file'], ...$config['source_roots']] as $private) {
            if (self::inside($private, $public) || self::inside($private, $config['web_root'])) {
                throw new RuntimeException('Keep archives, data and the password file outside the public and frontend directories.');
            }
        }
        foreach ($config['source_roots'] as $root) {
            if (self::inside($public, $root) || self::inside($config['web_root'], $root)) {
                throw new RuntimeException('An archive directory must not contain the application directories.');
            }
        }
        $ancestor = $config['data_dir'];
        while (!file_exists($ancestor)) {
            $ancestor = dirname($ancestor);
        }
        if (!is_dir($ancestor) || !is_writable($ancestor)) {
            throw new RuntimeException('The data directory (or its existing parent) must be writable.');
        }
        if (!is_dir(dirname($config['password_file'])) || is_dir($config['password_file'])) {
            throw new RuntimeException('The password file must have an existing parent directory and must not be a directory.');
        }
        if (in_array($config['password_file'], [$this->baseDir . '/config.php', $this->baseDir . '/.setup-token', $this->baseDir . '/.setup.lock'], true)) {
            throw new RuntimeException('Choose a separate file for the password hashes.');
        }
        $timezone = $values['timezone'] ?? '';
        try {
            if (!is_string($timezone) || $timezone === '') {
                throw new \InvalidArgumentException();
            }
            new \DateTimeZone($timezone);
        } catch (\Throwable) {
            throw new RuntimeException('Enter a valid timezone, for example Europe/Zurich or UTC.');
        }
        $config['timezone'] = $timezone;
        foreach (['file_settle_seconds', 'snapshot_max_distance_seconds'] as $key) {
            $value = filter_var($values[$key] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 0]]);
            if ($value === false) {
                throw new RuntimeException($key . ' must be a whole number of seconds, zero or greater.');
            }
            $config[$key] = $value;
        }
        $config['admin'] = filter_var($values['admin'] ?? null, FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE);
        if ($config['admin'] === null || !array_key_exists('admin', $values)) {
            throw new RuntimeException('Choose whether authenticated users can administer cameras.');
        }
        return $config;
    }

    public function hasUsers(string $file): bool
    {
        foreach (is_file($file) && is_readable($file) ? file($file, FILE_IGNORE_NEW_LINES) ?: [] : [] as $line) {
            $parts = explode(':', $line, 2);
            if (count($parts) === 2 && $parts[0] !== '' && preg_match('/^\$2[aby]\$\d{2}\$[.\/A-Za-z0-9]{53}$/', $parts[1])) {
                return true;
            }
        }
        return false;
    }

    private function fileHash(string $file): string
    {
        $hash = hash_file('sha256', $file);
        if ($hash === false) {
            throw new RuntimeException('Cannot read existing file: ' . $file);
        }
        return $hash;
    }

    private function stage(string $file, string $content): string
    {
        if (!is_writable(dirname($file))) {
            throw new RuntimeException('Cannot write to directory: ' . dirname($file));
        }
        $temporary = tempnam(dirname($file), '.ctv-setup-');
        if ($temporary === false) {
            throw new RuntimeException('Cannot write to directory: ' . dirname($file));
        }
        try {
            if (!chmod($temporary, 0640) || file_put_contents($temporary, $content) !== strlen($content)) {
                throw new RuntimeException('Cannot save private file: ' . $file);
            }
            return $temporary;
        } catch (\Throwable $error) {
            unlink($temporary);
            throw $error;
        }
    }

    /** A null password preserves an existing bcrypt file; updates retain other users. */
    public function save(array $config, string $username, ?string $password, ?string $expectedConfigHash): void
    {
        $this->checkRequirements();
        $config = $this->validate($config);
        if ($password !== null) {
            if (!preg_match('/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/D', $username)) {
                throw new RuntimeException('Use 1–64 letters, numbers, dots, underscores or hyphens for the username. Start with a letter or number.');
            }
            if (strlen($password) < 12 || strlen($password) > 72 || str_contains($password, "\0")) {
                throw new RuntimeException('Use a password of 12–72 bytes; bcrypt cannot safely use a longer password.');
            }
        }
        $lock = fopen($this->baseDir . '/.setup.lock', 'c');
        if ($lock === false || !flock($lock, LOCK_EX)) {
            throw new RuntimeException('Cannot lock setup files.');
        }
        $stagedConfig = $stagedPassword = $backupPassword = null;
        try {
            if ($this->configurationHash() !== $expectedConfigHash) {
                throw new RuntimeException('Configuration changed during setup. Restart the wizard.');
            }
            $file = $config['password_file'];
            $originalPassword = is_file($file) ? file_get_contents($file) : null;
            if ($originalPassword === false) {
                throw new RuntimeException('Cannot read the existing password file.');
            }
            foreach (explode("\n", $originalPassword ?? '') as $line) {
                $line = trim($line);
                if ($line !== '' && !str_starts_with($line, '#') && !preg_match('/^[^\x00-\x20:\x7f]+:[^\x00-\x20\x7f]+$/D', $line)) {
                    throw new RuntimeException('The selected password file contains other data. Choose a new file; setup will not overwrite it.');
                }
            }
            if ($password === null && !$this->hasUsers($file)) {
                throw new RuntimeException('A new username and password are required: no readable bcrypt users were found.');
            }
            if (!is_dir($config['data_dir']) && !mkdir($config['data_dir'], 0770, true) && !is_dir($config['data_dir'])) {
                throw new RuntimeException('Cannot create the data directory.');
            }
            $stagedConfig = $this->stage($this->baseDir . '/config.php', "<?php\n\ndeclare(strict_types=1);\n\nreturn " . var_export($config, true) . ";\n");
            if ($password !== null) {
                $lines = array_filter(explode("\n", $originalPassword ?? ''), static fn (string $line): bool => $line !== '' && explode(':', $line, 2)[0] !== $username);
                $lines[] = $username . ':' . password_hash($password, PASSWORD_BCRYPT, ['cost' => 10]);
                $stagedPassword = $this->stage($file, implode("\n", $lines) . "\n");
                if ($originalPassword !== null) {
                    $backupPassword = $this->stage($file, $originalPassword);
                }
                clearstatcache(true, $file);
                if ((is_file($file) ? file_get_contents($file) : null) !== $originalPassword) {
                    throw new RuntimeException('Password file changed during setup. Restart the wizard.');
                }
                if (!rename($stagedPassword, $file)) {
                    throw new RuntimeException('Cannot install the password file.');
                }
                $stagedPassword = null;
            }
            if (!rename($stagedConfig, $this->baseDir . '/config.php')) {
                if ($password !== null) {
                    if ($backupPassword !== null) {
                        if (!rename($backupPassword, $file)) {
                            $recoveryFile = $backupPassword;
                            $backupPassword = null;
                            throw new RuntimeException('Configuration save failed; restore the password file from ' . $recoveryFile);
                        }
                        $backupPassword = null;
                    } else {
                        unlink($file);
                    }
                }
                throw new RuntimeException('Cannot install config.php; previous login credentials were preserved.');
            }
            $stagedConfig = null;
            if (is_file($this->baseDir . '/.setup-token')) {
                unlink($this->baseDir . '/.setup-token');
            }
        } finally {
            foreach ([$stagedConfig, $stagedPassword, $backupPassword] as $temporary) {
                if ($temporary !== null) {
                    unlink($temporary);
                }
            }
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }

    /** Generated on first web visit; only the hosting account can read it. */
    public function webToken(): string
    {
        $file = $this->baseDir . '/.setup-token';
        if (!file_exists($file)) {
            $handle = @fopen($file, 'x');
            if ($handle !== false) {
                try {
                    $token = bin2hex(random_bytes(32));
                    if (!chmod($file, 0600) || fwrite($handle, $token . "\n") !== 65) {
                        throw new RuntimeException('Cannot create the private setup token. Use php ctv_php/setup.php instead.');
                    }
                } finally {
                    fclose($handle);
                }
            }
        }
        $token = is_file($file) && is_readable($file) ? trim((string) file_get_contents($file)) : '';
        if (!preg_match('/^[a-f0-9]{64}$/D', $token)) {
            throw new RuntimeException('Cannot read the private setup token. Use php ctv_php/setup.php, or remove ctv_php/.setup-token in the hosting file manager and reload.');
        }
        return $token;
    }

    public function discover(array $config): int
    {
        require_once __DIR__ . '/Database.php';
        require_once __DIR__ . '/Indexer.php';
        return (new Indexer(new Database($config['data_dir'] . '/ctv.sqlite'), $config))->discover();
    }
}
