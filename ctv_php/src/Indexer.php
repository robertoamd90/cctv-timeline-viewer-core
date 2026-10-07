<?php

declare(strict_types=1);

namespace CtvPhp;

require_once __DIR__ . '/SourcePaths.php';

use DateTimeImmutable;
use DateTimeZone;
use PDO;
use RecursiveDirectoryIterator;
use RecursiveIteratorIterator;
use FilesystemIterator;

final class Indexer
{
    private PDO $db;
    private array $config;

    public function __construct(Database $database, array $config)
    {
        $this->db = $database->pdo();
        $this->config = $config;
    }

    /** @return array{new:int,updated:int,missing:int,skipped:int,total:int} */
    public function indexPartition(array $camera, string $day): array
    {
        if (SourcePaths::resolve($camera['source_path'], $this->config['source_roots']) === null && is_dir($camera['source_path'])) {
            throw new \RuntimeException('Camera source is outside configured roots');
        }
        $path = $this->partitionPath($camera['source_path'], $camera['directory_pattern'], $day);
        if (!is_dir($path)) {
            $this->savePartitionState((int) $camera['id'], $day, 'missing', 0, 0);
            $missing = $this->db->prepare("UPDATE recordings SET availability='missing' WHERE camera_id=? AND partition_key=? AND availability='available'");
            $missing->execute([$camera['id'], $day]);
            $this->db->prepare('UPDATE cameras SET source_status = ?, source_error = NULL, last_scan_completed = ? WHERE id = ?')
                ->execute([is_dir($camera['source_path']) ? 'online' : 'offline', microtime(true), $camera['id']]);
            return ['new' => 0, 'updated' => 0, 'missing' => $missing->rowCount(), 'skipped' => 0, 'total' => 0];
        }
        return $this->indexDirectory($camera, $path, $day, true);
    }

    /** @return array{new:int,updated:int,missing:int,skipped:int,total:int} */
    public function indexFull(array $camera): array
    {
        return $this->indexDirectory($camera, $camera['source_path'], null, true);
    }

    /** Find date directories without walking the recordings inside each day. */
    public function partitionDays(array $camera): array
    {
        $root = SourcePaths::resolve($camera['source_path'], $this->config['source_roots']);
        if ($root === null || !is_dir($root)) {
            throw new \RuntimeException('Camera source unavailable or outside configured roots');
        }
        $pattern = $this->validatePattern($camera['directory_pattern']);
        preg_match_all('/\{(?:YYYY|YY|MM|DD)\}/', $pattern, $tokens);
        $expression = $this->patternExpression($pattern);
        $days = [];
        foreach ($this->partitionDirectories($root, explode('/', $pattern), '', $root) as $relative) {
            preg_match($expression, $relative, $matches);
            $values = array_combine($tokens[0], array_slice($matches, 1));
            // Two-digit archive years are interpreted as 2000–2099.
            $year = isset($values['{YYYY}']) ? (int) $values['{YYYY}'] : 2000 + (int) $values['{YY}'];
            $month = (int) $values['{MM}'];
            $day = (int) $values['{DD}'];
            if (!checkdate($month, $day, $year)) {
                continue;
            }
            $date = sprintf('%04d-%02d-%02d', $year, $month, $day);
            // Also reject conflicting repeated tokens, e.g. 2026/25/10/07.
            if ($this->partitionPath($root, $pattern, $date) === $root . '/' . $relative) {
                $days[$date] = true;
            }
        }
        if (isset($camera['id'])) {
            // Revisit known dates too, so removing a whole day marks its rows missing.
            $known = $this->db->prepare('SELECT partition_key FROM partitions WHERE camera_id=? UNION SELECT partition_key FROM recordings WHERE camera_id=? AND partition_key IS NOT NULL');
            $known->execute([$camera['id'], $camera['id']]);
            foreach ($known as $row) {
                $days[$row['partition_key']] = true;
            }
        }
        $dates = array_keys($days);
        sort($dates, SORT_STRING);
        return $dates;
    }

    private function patternExpression(string $pattern): string
    {
        return '~\A' . strtr(preg_quote($pattern, '~'), [
            '\{YYYY\}' => '([0-9]{4})', '\{YY\}' => '([0-9]{2})',
            '\{MM\}' => '([0-9]{2})', '\{DD\}' => '([0-9]{2})',
        ]) . '\z~';
    }

    /** Only descend through matching pattern components, within the camera. */
    private function partitionDirectories(string $directory, array $parts, string $relative, string $cameraRoot): \Generator
    {
        if ($parts === []) {
            yield $relative;
            return;
        }
        $expression = $this->patternExpression(array_shift($parts));
        foreach (new \DirectoryIterator($directory) as $entry) {
            if ($entry->isDot() || !$entry->isDir() || !preg_match($expression, $entry->getFilename())) {
                continue;
            }
            $path = SourcePaths::resolve($entry->getPathname(), $this->config['source_roots'], $cameraRoot);
            if ($path === null) {
                continue;
            }
            yield from $this->partitionDirectories($path, $parts,
                $relative === '' ? $entry->getFilename() : $relative . '/' . $entry->getFilename(), $cameraRoot);
        }
    }

    private function hasDateLayout(string $root): bool
    {
        foreach ($this->partitionDirectories($root, ['{YYYY}'], '', $root) as $year) {
            if ((int) $year === 0) {
                continue;
            }
            $path = SourcePaths::resolve($root . '/' . $year, $this->config['source_roots'], $root);
            if ($path === null) {
                continue;
            }
            $empty = true;
            foreach (new \DirectoryIterator($path) as $entry) {
                if ($entry->isDot()) {
                    continue;
                }
                $empty = false;
                if ($entry->isDir() && preg_match('/^(?:0[1-9]|1[0-2])$/D', $entry->getFilename())
                    && SourcePaths::resolve($entry->getPathname(), $this->config['source_roots'], $root) !== null) {
                    return true;
                }
            }
            if ($empty) {
                return true;
            }
        }
        return false;
    }

    public function discover(): int
    {
        $insert = $this->db->prepare(
            "INSERT OR IGNORE INTO cameras (name, source_path, timezone, indexing_mode, directory_pattern, source_status) VALUES (?, ?, ?, 'partitioned', '{YYYY}/{MM}/{DD}', 'unknown')"
        );
        $count = 0;
        foreach ($this->config['source_roots'] as $root) {
            $root = SourcePaths::resolve($root, $this->config['source_roots']);
            if ($root === null || !is_dir($root)) {
                continue;
            }
            // A configured root can be a camera itself, not just its parent.
            if ($this->hasDateLayout($root)) {
                $insert->execute([basename($root), $root, $this->config['timezone']]);
                $count += $insert->rowCount();
                continue;
            }
            foreach (new \DirectoryIterator($root) as $entry) {
                if ($entry->isDot() || !$entry->isDir()) {
                    continue;
                }
                $source = SourcePaths::resolve($entry->getPathname(), $this->config['source_roots']);
                if ($source === null) {
                    continue;
                }
                $insert->execute([$entry->getFilename(), $source, $this->config['timezone']]);
                $count += $insert->rowCount();
            }
        }
        return $count;
    }

    public function extractTimestamp(string $filename, string $timezone): ?float
    {
        $patterns = [
            '/(\d{4})(\d{2})(\d{2})_?(\d{2})(\d{2})(\d{2})/',
            '/(\d{4})-(\d{2})-(\d{2})_?(\d{2})-?(\d{2})-?(\d{2})/',
        ];
        foreach ($patterns as $pattern) {
            if (!preg_match($pattern, $filename, $matches)) {
                continue;
            }
            try {
                $zone = new DateTimeZone($timezone);
                $stamp = sprintf('%04d%02d%02d%02d%02d%02d', ...array_map('intval', array_slice($matches, 1, 6)));
                $date = DateTimeImmutable::createFromFormat('!YmdHis', $stamp, $zone);
                if ($date !== false && $date->format('YmdHis') === $stamp) {
                    return (float) $date->getTimestamp();
                }
            } catch (\Throwable) {
                return null;
            }
        }
        return null;
    }

    public function partitionPath(string $root, string $pattern, string $day): string
    {
        $date = DateTimeImmutable::createFromFormat('!Y-m-d', $day, new DateTimeZone('UTC'));
        if ($date === false || $date->format('Y-m-d') !== $day) {
            throw new \InvalidArgumentException('Invalid date: ' . $day);
        }
        $relative = $this->validatePattern($pattern);
        $relative = str_replace(
            ['{YYYY}', '{YY}', '{MM}', '{DD}'],
            [$date->format('Y'), $date->format('y'), $date->format('m'), $date->format('d')],
            $relative
        );
        return rtrim($root, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $relative);
    }

    public function validatePattern(string $pattern): string
    {
        $pattern = trim($pattern, " \t\n\r\0\x0B/");
        if ($pattern === '' || str_starts_with($pattern, DIRECTORY_SEPARATOR) || in_array('..', explode('/', $pattern), true)) {
            throw new \InvalidArgumentException('Invalid directory pattern.');
        }
        $remaining = str_replace(['{YYYY}', '{YY}', '{MM}', '{DD}'], '', $pattern);
        if (str_contains($remaining, '{') || str_contains($remaining, '}')) {
            throw new \InvalidArgumentException('Supported tokens: {YYYY}, {YY}, {MM}, {DD}.');
        }
        if ((!str_contains($pattern, '{YYYY}') && !str_contains($pattern, '{YY}')) || !str_contains($pattern, '{MM}') || !str_contains($pattern, '{DD}')) {
            throw new \InvalidArgumentException('Pattern must contain year, month and day tokens.');
        }
        return $pattern;
    }

    /** @return array{new:int,updated:int,missing:int,skipped:int,total:int} */
    private function indexDirectory(array $camera, string $directory, ?string $partitionKey, bool $reconcileMissing): array
    {
        $cameraId = (int) $camera['id'];
        $started = microtime(true);
        $this->db->prepare('UPDATE cameras SET source_status = ?, source_error = NULL, last_scan_started = ? WHERE id = ?')
            ->execute(['scanning', $started, $cameraId]);
        if ($partitionKey !== null) {
            $this->savePartitionState($cameraId, $partitionKey, 'scanning', 0, 0);
        }

        try {
            $safeDirectory = SourcePaths::resolve($directory, $this->config['source_roots'], $camera['source_path']);
            if ($safeDirectory === null) {
                throw new \RuntimeException('Source directory unavailable or outside configured roots');
            }
            [$videos, $snapshots] = $this->listMedia($safeDirectory, $camera['timezone'], $camera['source_path']);
            $total = count($videos);
            if ($partitionKey !== null) {
                $this->savePartitionState($cameraId, $partitionKey, 'scanning', 0, $total);
            }

            $existingSql = 'SELECT id, path, size, mtime, duration, thumbnail_path, availability FROM recordings WHERE camera_id = ?';
            $params = [$cameraId];
            if ($partitionKey !== null) {
                $existingSql .= ' AND partition_key = ?';
                $params[] = $partitionKey;
            }
            $stmt = $this->db->prepare($existingSql);
            $stmt->execute($params);
            $existing = [];
            foreach ($stmt as $row) {
                $existing[$row['path']] = $row;
            }

            $seen = [];
            $prepared = [];
            $restores = [];
            $missingIds = [];
            $counts = ['new' => 0, 'updated' => 0, 'missing' => 0, 'skipped' => 0, 'total' => $total];
            $now = time();
            $settle = max(0, (int) $this->config['file_settle_seconds']);

            // Parsing MP4 metadata can be comparatively slow. Do all filesystem
            // and media work before opening a SQLite write transaction so web
            // requests and cron scans do not hold the database write lock while
            // walking/re-reading large recording files.
            foreach ($videos as $video) {
                $path = $video['path'];
                $seen[$path] = true;
                $previous = $existing[$path] ?? null;
                $unchanged = $previous !== null
                    && (int) $previous['size'] === $video['size']
                    && abs((float) $previous['mtime'] - $video['mtime']) < 0.001
                    && (float) $previous['duration'] > 0;

                if ($unchanged) {
                    $thumbnail = $previous['thumbnail_path'];
                    if ($thumbnail === null || !is_file($thumbnail)
                        || SourcePaths::resolve($thumbnail, $this->config['source_roots'], $camera['source_path']) === null) {
                        $start = $this->extractTimestamp($video['filename'], $camera['timezone']) ?? $video['mtime'];
                        $thumbnail = $this->nearestSnapshot($start, $snapshots);
                    }
                    if ($previous['availability'] !== 'available' || $thumbnail !== $previous['thumbnail_path']) {
                        $restores[] = [$thumbnail, (int) $previous['id']];
                    }
                    $counts['skipped']++;
                    continue;
                }

                if ($settle > 0 && ($now - (int) $video['mtime']) < $settle) {
                    $counts['skipped']++;
                    continue;
                }

                $start = $this->extractTimestamp($video['filename'], $camera['timezone']) ?? $video['mtime'];
                $duration = Mp4Metadata::duration($path);
                if ($duration <= 0) {
                    // Most commonly this is still an incomplete FTP upload.
                    // Leave an existing row untouched; a later scan retries it.
                    $counts['skipped']++;
                    continue;
                }

                $prepared[] = [
                    $cameraId,
                    $path,
                    $video['filename'],
                    $start,
                    $start + $duration,
                    $duration,
                    '',
                    '',
                    0,
                    $video['size'],
                    $video['mtime'],
                    $this->nearestSnapshot($start, $snapshots),
                    $partitionKey,
                ];
                $counts[$previous === null ? 'new' : 'updated']++;
            }

            if ($reconcileMissing) {
                foreach ($existing as $path => $row) {
                    if (!isset($seen[$path]) && $row['availability'] !== 'missing') {
                        $missingIds[] = (int) $row['id'];
                    }
                }
                $counts['missing'] = count($missingIds);
            }

            $this->db->beginTransaction();
            try {
                if ($prepared !== []) {
                    $upsert = $this->db->prepare(<<<'SQL'
INSERT INTO recordings (camera_id, path, filename, start_ts, end_ts, duration, codec, resolution, fps, size, mtime, thumbnail_path, partition_key, media_kind, availability)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'video', 'available')
ON CONFLICT(camera_id, path) DO UPDATE SET
    filename=excluded.filename,
    start_ts=excluded.start_ts,
    end_ts=excluded.end_ts,
    duration=excluded.duration,
    codec=excluded.codec,
    resolution=excluded.resolution,
    fps=excluded.fps,
    size=excluded.size,
    mtime=excluded.mtime,
    thumbnail_path=excluded.thumbnail_path,
    partition_key=excluded.partition_key,
    availability='available'
SQL);
                    foreach ($prepared as $values) {
                        $upsert->execute($values);
                    }
                }

                if ($restores !== []) {
                    $restore = $this->db->prepare("UPDATE recordings SET availability='available', thumbnail_path=? WHERE id=?");
                    foreach ($restores as $values) {
                        $restore->execute($values);
                    }
                }

                if ($missingIds !== []) {
                    $markMissing = $this->db->prepare("UPDATE recordings SET availability='missing' WHERE id=?");
                    foreach ($missingIds as $id) {
                        $markMissing->execute([$id]);
                    }
                }

                $this->db->commit();
            } catch (\Throwable $error) {
                if ($this->db->inTransaction()) {
                    $this->db->rollBack();
                }
                throw $error;
            }

            $finished = microtime(true);
            $this->db->prepare('UPDATE cameras SET source_status = ?, source_error = NULL, last_scan_completed = ? WHERE id = ?')
                ->execute(['online', $finished, $cameraId]);
            if ($partitionKey !== null) {
                $this->savePartitionState($cameraId, $partitionKey, 'ready', $total, $total);
            }
            return $counts;
        } catch (\Throwable $error) {
            $this->db->prepare('UPDATE cameras SET source_status = ?, source_error = ?, last_scan_completed = ? WHERE id = ?')
                ->execute(['offline', $error->getMessage(), microtime(true), $cameraId]);
            if ($partitionKey !== null) {
                $this->savePartitionState($cameraId, $partitionKey, 'error', 0, 0);
            }
            throw $error;
        }
    }

    /** @return array{0:list<array{path:string,filename:string,size:int,mtime:float}>,1:list<array{path:string,ts:float}>} */
    private function listMedia(string $directory, string $timezone, string $cameraRoot): array
    {
        $videos = [];
        $snapshots = [];
        $iterator = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($directory, FilesystemIterator::SKIP_DOTS)
        );
        foreach ($iterator as $file) {
            if (!$file->isFile()) {
                continue;
            }
            $safePath = SourcePaths::resolve($file->getPathname(), $this->config['source_roots'], $cameraRoot);
            if ($safePath === null) {
                continue;
            }
            $extension = strtolower($file->getExtension());
            if ($extension === 'mp4') {
                $videos[] = [
                    'path' => $safePath,
                    'filename' => $file->getFilename(),
                    'size' => (int) $file->getSize(),
                    'mtime' => (float) $file->getMTime(),
                ];
            } elseif ($extension === 'jpg' || $extension === 'jpeg') {
                $ts = $this->extractTimestamp($file->getFilename(), $timezone);
                if ($ts !== null) {
                    $snapshots[] = ['path' => $safePath, 'ts' => $ts];
                }
            }
        }
        usort($videos, static fn (array $a, array $b): int => strcmp($a['path'], $b['path']));
        usort($snapshots, static fn (array $a, array $b): int => $a['ts'] <=> $b['ts']);
        return [$videos, $snapshots];
    }

    private function nearestSnapshot(float $start, array $snapshots): ?string
    {
        if ($snapshots === []) {
            return null;
        }
        $maxDistance = max(0, (int) $this->config['snapshot_max_distance_seconds']);
        $best = null;
        $bestDistance = INF;
        foreach ($snapshots as $snapshot) {
            $distance = abs($snapshot['ts'] - $start);
            if ($distance < $bestDistance) {
                $best = $snapshot['path'];
                $bestDistance = $distance;
            }
            if ($snapshot['ts'] > $start && $distance > $bestDistance) {
                break;
            }
        }
        return $best !== null && $bestDistance <= $maxDistance ? $best : null;
    }

    private function savePartitionState(int $cameraId, string $key, string $status, int $done, int $total): void
    {
        $stmt = $this->db->prepare(<<<'SQL'
INSERT INTO partitions (camera_id, partition_key, status, progress_done, progress_total, last_scanned)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(camera_id, partition_key) DO UPDATE SET
    status=excluded.status,
    progress_done=excluded.progress_done,
    progress_total=excluded.progress_total,
    last_scanned=excluded.last_scanned
SQL);
        $stmt->execute([$cameraId, $key, $status, $done, $total, microtime(true)]);
    }
}
