<?php

declare(strict_types=1);

namespace CtvPhp;

/** Apply the same archive boundary to discovery, indexing and HTTP delivery. */
final class SourcePaths
{
    public static function contains(string $root, string $path): bool
    {
        return $path === $root || str_starts_with($path, rtrim($root, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR);
    }

    public static function resolve(string $path, array $roots, ?string $cameraRoot = null): ?string
    {
        // Long-lived PHP workers can retain paths after an FTP-side replacement.
        clearstatcache(true);
        if (str_contains($path, "\0")) {
            return null;
        }
        $real = realpath($path);
        if ($real === false) {
            return null;
        }
        if ($cameraRoot !== null) {
            $camera = realpath($cameraRoot);
            if ($camera === false || !self::contains($camera, $real)) {
                return null;
            }
            // The camera itself must still belong to a currently configured root.
            $boundary = $camera;
        } else {
            $boundary = $real;
        }
        foreach ($roots as $root) {
            $rootReal = realpath($root);
            if ($rootReal !== false && self::contains($rootReal, $boundary)) {
                return $real;
            }
        }
        return null;
    }
}
