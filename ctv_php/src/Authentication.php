<?php

declare(strict_types=1);

namespace CtvPhp;

final class Authentication
{
    /** Verify every request, including video ranges, before opening the database. */
    public static function requireUser(array $config): string
    {
        $file = $config['password_file'];
        $lines = is_file($file) && is_readable($file) ? file($file, FILE_IGNORE_NEW_LINES) : false;
        $users = [];
        foreach ($lines ?: [] as $line) {
            $parts = explode(':', $line, 2);
            // htpasswd -B produces bcrypt hashes understood by password_verify.
            if (count($parts) === 2 && $parts[0] !== '' && preg_match('/^\$2[aby]\$/', $parts[1])) {
                $users[$parts[0]] = $parts[1];
            }
        }
        if ($users === []) {
            throw new HttpException(503, 'Password protection is not configured. Run php ctv_php/setup.php or follow the installation guide in ctv_php/README.md.');
        }

        $user = $_SERVER['PHP_AUTH_USER'] ?? null;
        $password = $_SERVER['PHP_AUTH_PW'] ?? null;
        if ($user === null || $password === null) {
            $authorization = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
            if (preg_match('/^Basic\s+(\S+)$/i', $authorization, $matches)) {
                $decoded = base64_decode($matches[1], true);
                if ($decoded !== false && str_contains($decoded, ':')) {
                    [$user, $password] = explode(':', $decoded, 2);
                }
            }
        }
        if (is_string($user) && is_string($password) && isset($users[$user]) && password_verify($password, $users[$user])) {
            return $user;
        }

        header('WWW-Authenticate: Basic realm="CCTV viewer", charset="UTF-8"');
        throw new HttpException(401, 'Authentication required');
    }
}
