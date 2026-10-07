<?php

declare(strict_types=1);

namespace CtvPhp;

final class Http
{
    public static function json(mixed $data, int $status = 200): never
    {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
        echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
        exit;
    }

    public static function body(): array
    {
        $raw = file_get_contents('php://input');
        if ($raw === false || trim($raw) === '') {
            return [];
        }
        $data = json_decode($raw, true);
        if (!is_array($data)) {
            throw new HttpException(400, 'Invalid JSON body');
        }
        return $data;
    }

    public static function serveFile(string $path, string $mime, bool $allowRange = false, array $patches = []): never
    {
        if (!is_file($path) || !is_readable($path)) {
            throw new HttpException(404, 'File not found');
        }
        $size = filesize($path);
        if ($size === false) {
            throw new HttpException(500, 'Unable to determine file size');
        }

        header('Content-Type: ' . $mime);
        header('X-Content-Type-Options: nosniff');
        // Revalidate frontend assets after deployments; do not retain footage.
        header('Cache-Control: ' . (str_starts_with($mime, 'image/') || str_starts_with($mime, 'video/') ? 'private, no-store' : 'no-cache'));
        if (!$allowRange) {
            header('Content-Length: ' . $size);
            if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'HEAD') {
                readfile($path);
            }
            exit;
        }

        header('Accept-Ranges: bytes');
        $start = 0;
        $end = $size - 1;
        $range = $_SERVER['HTTP_RANGE'] ?? '';
        if ($range !== '') {
            if (!preg_match('/^bytes=(\d*)-(\d*)$/', trim($range), $matches)
                || ($matches[1] === '' && $matches[2] === '')) {
                http_response_code(416);
                header('Content-Range: bytes */' . $size);
                exit;
            }
            if ($matches[1] === '') {
                $suffix = (int) $matches[2];
                if ($suffix <= 0) {
                    http_response_code(416);
                    header('Content-Range: bytes */' . $size);
                    exit;
                }
                $start = max(0, $size - $suffix);
            } else {
                $start = (int) $matches[1];
                if ($matches[2] !== '') {
                    $end = min($end, (int) $matches[2]);
                }
            }
            if ($start > $end || $start >= $size) {
                http_response_code(416);
                header('Content-Range: bytes */' . $size);
                exit;
            }
            http_response_code(206);
            header(sprintf('Content-Range: bytes %d-%d/%d', $start, $end, $size));
        }

        $length = $end - $start + 1;
        header('Content-Length: ' . $length);
        if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'HEAD') {
            exit;
        }

        @set_time_limit(0);
        while (ob_get_level() > 0) {
            @ob_end_clean();
        }
        $handle = fopen($path, 'rb');
        if ($handle === false) {
            throw new HttpException(500, 'Unable to open file');
        }
        try {
            if ($start > 0) {
                fseek($handle, $start);
            }
            $remaining = $length;
            while ($remaining > 0 && !feof($handle) && connection_status() === CONNECTION_NORMAL) {
                $chunk = fread($handle, min(1024 * 1024, $remaining));
                if ($chunk === false || $chunk === '') {
                    break;
                }
                if ($patches !== []) {
                    $absoluteOffset = $end - $remaining + 1;
                    $chunk = self::patchChunk($chunk, $absoluteOffset, $patches);
                }
                echo $chunk;
                $remaining -= strlen($chunk);
                flush();
            }
        } finally {
            fclose($handle);
        }
        exit;
    }
    /** @param list<array{offset:int,bytes:string}> $patches */
    private static function patchChunk(string $chunk, int $absoluteOffset, array $patches): string
    {
        $chunkEnd = $absoluteOffset + strlen($chunk);
        foreach ($patches as $patch) {
            $patchStart = $patch['offset'];
            $patchEnd = $patchStart + strlen($patch['bytes']);
            $overlapStart = max($absoluteOffset, $patchStart);
            $overlapEnd = min($chunkEnd, $patchEnd);
            if ($overlapStart >= $overlapEnd) {
                continue;
            }
            $sourceStart = $overlapStart - $patchStart;
            $targetStart = $overlapStart - $absoluteOffset;
            $length = $overlapEnd - $overlapStart;
            $chunk = substr_replace($chunk, substr($patch['bytes'], $sourceStart, $length), $targetStart, $length);
        }
        return $chunk;
    }

}

final class HttpException extends \RuntimeException
{
    public function __construct(public readonly int $status, string $message)
    {
        parent::__construct($message);
    }
}
