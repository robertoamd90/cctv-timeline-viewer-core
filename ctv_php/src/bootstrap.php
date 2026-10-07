<?php

declare(strict_types=1);

namespace CtvPhp;

require_once __DIR__ . '/Database.php';
require_once __DIR__ . '/Mp4Metadata.php';
require_once __DIR__ . '/Indexer.php';
require_once __DIR__ . '/Http.php';
require_once __DIR__ . '/Authentication.php';
require_once __DIR__ . '/SourcePaths.php';
require_once __DIR__ . '/Router.php';

function config(): array
{
    static $config;
    if ($config !== null) {
        return $config;
    }

    $baseDir = dirname(__DIR__);
    $defaults = [
        'source_roots' => [],
        'data_dir' => $baseDir . '/var',
        'web_root' => dirname($baseDir) . '/ctv_web',
        'timezone' => 'Europe/Zurich',
        'file_settle_seconds' => 30,
        'snapshot_max_distance_seconds' => 90,
        'admin' => true,
        'password_file' => $baseDir . '/.htpasswd',
    ];

    $fileConfig = [];
    $configFile = $baseDir . '/config.php';
    if (is_file($configFile)) {
        $loaded = require $configFile;
        if (!is_array($loaded)) {
            throw new \RuntimeException('ctv_php/config.php must return an array.');
        }
        $fileConfig = $loaded;
    }

    $envRoots = getenv('CTV_PHP_SOURCE_ROOTS');
    $envConfig = [];
    if ($envRoots !== false && trim($envRoots) !== '') {
        $envConfig['source_roots'] = preg_split('/[;\n]+/', $envRoots, -1, PREG_SPLIT_NO_EMPTY) ?: [];
    }
    foreach ([
        'CTV_PHP_DATA_DIR' => 'data_dir',
        'CTV_PHP_WEB_ROOT' => 'web_root',
        'CTV_PHP_TIMEZONE' => 'timezone',
        'CTV_PHP_PASSWORD_FILE' => 'password_file',
    ] as $envName => $key) {
        $value = getenv($envName);
        if ($value !== false && trim($value) !== '') {
            $envConfig[$key] = trim($value);
        }
    }

    $config = array_replace($defaults, $fileConfig, $envConfig);
    $envAdmin = getenv('CTV_PHP_ADMIN');
    if ($envAdmin !== false) {
        $admin = filter_var($envAdmin, FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE);
        if ($admin === null) {
            throw new \RuntimeException('CTV_PHP_ADMIN must be a boolean.');
        }
        $config['admin'] = $admin;
    }
    $config['source_roots'] = array_values(array_filter(array_map(
        static fn ($path): string => rtrim((string) $path, DIRECTORY_SEPARATOR),
        (array) $config['source_roots']
    ), static fn (string $path): bool => $path !== ''));
    $config['data_dir'] = rtrim((string) $config['data_dir'], DIRECTORY_SEPARATOR);
    $config['web_root'] = rtrim((string) $config['web_root'], DIRECTORY_SEPARATOR);

    if (!is_dir($config['data_dir']) && !mkdir($config['data_dir'], 0770, true) && !is_dir($config['data_dir'])) {
        throw new \RuntimeException('Unable to create data directory: ' . $config['data_dir']);
    }

    date_default_timezone_set((string) $config['timezone']);

    return $config;
}

function database(): Database
{
    static $database;
    return $database ??= new Database(config()['data_dir'] . '/ctv.sqlite');
}
