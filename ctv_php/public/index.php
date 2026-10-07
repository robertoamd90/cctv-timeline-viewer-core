<?php

declare(strict_types=1);

require_once dirname(__DIR__) . '/src/bootstrap.php';

use CtvPhp\Router;
use CtvPhp\Http;
use CtvPhp\HttpException;
use function CtvPhp\config;

$uriPath = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$scriptName = str_replace('\\', '/', $_SERVER['SCRIPT_NAME'] ?? '/index.php');
$basePath = rtrim(str_replace('\\', '/', dirname($scriptName)), '/');
if ($basePath !== '' && $basePath !== '/' && str_starts_with($uriPath, $basePath . '/')) {
    $uriPath = substr($uriPath, strlen($basePath)) ?: '/';
}

try {
    (new Router(config()))->handle(strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET'), $uriPath);
} catch (HttpException $error) {
    Http::json(['detail' => $error->getMessage()], $error->status);
} catch (Throwable $error) {
    error_log('[ctv_php] ' . $error);
    Http::json(['detail' => 'Internal server error'], 500);
}
