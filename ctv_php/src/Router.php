<?php

declare(strict_types=1);

namespace CtvPhp;

use DateTimeImmutable;
use DateTimeZone;
use PDO;

final class Router
{
    private PDO $db;
    private Indexer $indexer;
    private string $user;

    public function __construct(private readonly array $config)
    {
        $this->user = Authentication::requireUser($config);
        $database = database();
        $this->db = $database->pdo();
        $this->indexer = new Indexer($database, $config);
    }

    public function handle(string $method, string $path): never
    {
        try {
            if (!in_array($method, ['GET', 'HEAD', 'OPTIONS'], true)
                && (($_SERVER['HTTP_X_CTV_REQUEST'] ?? '') !== '1'
                    || ($_SERVER['HTTP_SEC_FETCH_SITE'] ?? '') === 'cross-site')) {
                throw new HttpException(403, 'Same-origin X-CTV-Request header required');
            }
            if ($method === 'OPTIONS') {
                http_response_code(204);
                exit;
            }
            if ($path === '/' || $path === '/index.html') {
                Http::serveFile($this->config['web_root'] . '/index.html', 'text/html; charset=utf-8');
            }
            if ($path === '/style.css' || str_starts_with($path, '/js/')) {
                $this->serveStatic($path);
            }

            if ($path === '/api/session' && $method === 'GET') {
                $user = $this->user;
                Http::json([
                    'deployment' => 'php',
                    'authenticated' => true,
                    'user' => ['id' => $user, 'name' => $user, 'display_name' => $user],
                    'is_admin' => (bool) $this->config['admin'],
                    'role_resolved' => true,
                    'source_roots' => $this->config['admin'] ? array_values($this->config['source_roots']) : [],
                    'timeline_index' => ['strategy' => 'partition_btree', 'status' => 'ready'],
                    'capabilities' => [
                        'transcoding' => false,
                        'realtime_events' => false,
                        'home_assistant_events' => false,
                        'server_autoscan' => false,
                        'native_playback' => true,
                    ],
                ]);
            }
            if ($path === '/api/health' && $method === 'GET') {
                $offline = (int) $this->db->query("SELECT COUNT(*) FROM cameras WHERE source_status='offline'")->fetchColumn();
                Http::json(['status' => $offline ? 'degraded' : 'ok', 'database' => 'ok']);
            }
            if ($path === '/api/events' && $method === 'GET') {
                header('Content-Type: text/event-stream; charset=utf-8');
                header('Cache-Control: no-cache');
                echo "retry: 60000\n\n";
                exit;
            }
            if ($path === '/api/stream-profiles' && $method === 'GET') {
                Http::json([
                    'balanced' => ['scale_percent' => 100, 'fps' => 25, 'bitrate_kbps' => 8000],
                    'fast' => ['scale_percent' => 100, 'fps' => 25, 'bitrate_kbps' => 8000],
                ]);
            }
            if ($path === '/api/playback-status' && $method === 'GET') {
                Http::json(['active' => 0, 'max_transcoders' => 0, 'hls_temp_mb' => 0]);
            }
            if ($path === '/api/admin/ha-event-entities' && $method === 'GET') {
                Http::json(['entities' => []]);
            }
            if ($path === '/api/admin/autoscan-settings' && $method === 'GET') {
                Http::json(['enabled' => false, 'interval_minutes' => 60]);
            }

            if ($path === '/api/cameras') {
                if ($method === 'GET') {
                    Http::json($this->listCameras());
                }
                if ($method === 'POST') {
                    $this->requireAdmin();
                    Http::json($this->saveCamera(null, Http::body()), 201);
                }
            }
            if (preg_match('#^/api/cameras/(\d+)$#', $path, $m)) {
                $id = (int) $m[1];
                if ($method === 'GET') {
                    Http::json($this->camera($id));
                }
                $this->requireAdmin();
                if ($method === 'PUT') {
                    Http::json($this->saveCamera($id, Http::body()));
                }
                if ($method === 'DELETE') {
                    $stmt = $this->db->prepare('DELETE FROM cameras WHERE id = ?');
                    $stmt->execute([$id]);
                    if ($stmt->rowCount() === 0) {
                        throw new HttpException(404, 'Camera not found');
                    }
                    Http::json(['deleted' => $id]);
                }
            }

            if ($path === '/api/sources/directories' && $method === 'GET') {
                $this->requireAdmin();
                Http::json($this->sourceDirectories($_GET['path'] ?? null));
            }

            if ($path === '/api/timeline/bounds' && $method === 'GET') {
                Http::json($this->timelineBounds());
            }
            if ($path === '/api/timeline/prepare' && $method === 'POST') {
                Http::json($this->prepareTimeline(), 202);
            }
            if ($path === '/api/timeline' && $method === 'GET') {
                Http::json($this->timeline());
            }

            if ($path === '/api/recordings' && $method === 'GET') {
                Http::json($this->listRecordings());
            }
            if (preg_match('#^/api/recordings/(\d+)$#', $path, $m) && $method === 'GET') {
                Http::json($this->recording((int) $m[1]));
            }
            if (preg_match('#^/api/recordings/(\d+)/thumbnail$#', $path, $m) && $method === 'GET') {
                $row = $this->recordingRow((int) $m[1]);
                if ($row['availability'] !== 'available' || !$row['thumbnail_path']) {
                    throw new HttpException(404, 'Thumbnail not available');
                }
                Http::serveFile($this->mediaPath($row, $row['thumbnail_path']), 'image/jpeg');
            }
            if (preg_match('#^/video/(\d+)$#', $path, $m) && ($method === 'GET' || $method === 'HEAD')) {
                $row = $this->recordingRow((int) $m[1]);
                if ($row['availability'] !== 'available') {
                    throw new HttpException(410, 'Recording no longer available');
                }
                $file = $this->mediaPath($row, $row['path']);
                $patches = Mp4Metadata::durationPatches($file, (float) $row['duration']);
                Http::serveFile($file, 'video/mp4', true, $patches);
            }

            if ($path === '/api/search' && $method === 'GET') {
                Http::json($this->search());
            }
            if (preg_match('#^/api/scan/(\d+)$#', $path, $m) && $method === 'POST') {
                $this->requireAdmin();
                $camera = $this->camera((int) $m[1]);
                $counts = $camera['indexing_mode'] === 'full'
                    ? $this->indexer->indexFull($camera)
                    : $this->indexer->indexPartition($camera, $this->todayForCamera($camera));
                Http::json(['status' => 'done', 'camera_id' => $camera['id']] + $counts, 200);
            }
            if ($path === '/api/scan' && $method === 'POST') {
                $this->requireAdmin();
                $results = [];
                $failed = [];
                foreach ($this->listCameras() as $camera) {
                    try {
                        $results[] = $camera['indexing_mode'] === 'full'
                            ? $this->indexer->indexFull($camera)
                            : $this->indexer->indexPartition($camera, $this->todayForCamera($camera));
                    } catch (\Throwable $error) {
                        error_log('[ctv_php] Camera scan failed: ' . $error->getMessage());
                        $failed[] = $camera['id'];
                    }
                }
                Http::json(['status' => 'done', 'cameras' => count($results), 'failed_cameras' => $failed]);
            }
            if ($path === '/api/admin/rebuild-index' && $method === 'POST') {
                $this->requireAdmin();
                $recordings = (int) $this->db->query('SELECT COUNT(*) FROM recordings')->fetchColumn();
                $partitions = (int) $this->db->query('SELECT COUNT(*) FROM partitions')->fetchColumn();
                $this->db->beginTransaction();
                try {
                    $this->db->exec('DELETE FROM recordings');
                    $this->db->exec('DELETE FROM partitions');
                    $this->db->exec("UPDATE cameras SET source_status='unknown', source_error=NULL, last_scan_started=NULL, last_scan_completed=NULL");
                    $this->db->commit();
                } catch (\Throwable $error) {
                    $this->db->rollBack();
                    throw $error;
                }
                Http::json([
                    'status' => 'rebuilt',
                    'recordings_deleted' => $recordings,
                    'partitions_deleted' => $partitions,
                    'thumbnails_deleted' => 0,
                    'timeline_index' => ['strategy' => 'partition_btree', 'status' => 'ready'],
                ]);
            }

            throw new HttpException(404, 'Not found');
        } catch (HttpException $error) {
            Http::json(['detail' => $error->getMessage()], $error->status);
        } catch (\InvalidArgumentException $error) {
            Http::json(['detail' => $error->getMessage()], 422);
        } catch (\Throwable $error) {
            error_log('[ctv_php] ' . $error);
            Http::json(['detail' => 'Internal server error'], 500);
        }
    }

    private function serveStatic(string $path): never
    {
        $relative = ltrim($path, '/');
        $base = realpath($this->config['web_root']);
        $file = realpath($this->config['web_root'] . '/' . $relative);
        if ($base === false || $file === false || !str_starts_with($file, $base . DIRECTORY_SEPARATOR)) {
            throw new HttpException(404, 'Static file not found');
        }
        $mime = str_ends_with($file, '.css') ? 'text/css; charset=utf-8' : 'application/javascript; charset=utf-8';
        Http::serveFile($file, $mime);
    }

    private function requireAdmin(): void
    {
        if (!$this->config['admin']) {
            throw new HttpException(403, 'Administrator access required');
        }
    }

    private function mediaPath(array $row, string $path): string
    {
        $real = SourcePaths::resolve($path, $this->config['source_roots'], $row['camera_source_path']);
        if ($real === null || !is_file($real)) {
            throw new HttpException(404, 'File not found in configured archive');
        }
        return $real;
    }

    private function listCameras(): array
    {
        $rows = $this->db->query(<<<'SQL'
SELECT c.*,
       (SELECT COUNT(*) FROM recordings r WHERE r.camera_id=c.id AND r.availability='available') AS recordings_available,
       (SELECT COUNT(*) FROM recordings r WHERE r.camera_id=c.id AND r.availability='missing') AS recordings_missing
FROM cameras c
ORDER BY c.name
SQL)->fetchAll();
        return array_map([$this, 'publicCamera'], $rows);
    }

    private function camera(int $id): array
    {
        $stmt = $this->db->prepare(<<<'SQL'
SELECT c.*,
       (SELECT COUNT(*) FROM recordings r WHERE r.camera_id=c.id AND r.availability='available') AS recordings_available,
       (SELECT COUNT(*) FROM recordings r WHERE r.camera_id=c.id AND r.availability='missing') AS recordings_missing
FROM cameras c WHERE c.id=?
SQL);
        $stmt->execute([$id]);
        $row = $stmt->fetch();
        if (!$row) {
            throw new HttpException(404, 'Camera not found');
        }
        return $this->publicCamera($row);
    }

    private function publicCamera(array $row): array
    {
        return [
            'id' => (int) $row['id'],
            'name' => $row['name'],
            'source_path' => $row['source_path'],
            'timezone' => $row['timezone'],
            'time_offset_seconds' => (float) $row['time_offset_seconds'],
            'config' => '{}',
            'indexing_mode' => $row['indexing_mode'],
            'directory_pattern' => $row['directory_pattern'],
            'ha_event_entities' => $row['ha_event_entities'] ?? '',
            'event_overlay_position' => $row['event_overlay_position'] ?? 'top-right',
            'source_status' => $row['source_status'],
            'source_error' => $row['source_error'],
            'last_scan_started' => $row['last_scan_started'] !== null ? (float) $row['last_scan_started'] : null,
            'last_scan_completed' => $row['last_scan_completed'] !== null ? (float) $row['last_scan_completed'] : null,
            'recordings_available' => (int) ($row['recordings_available'] ?? 0),
            'recordings_missing' => (int) ($row['recordings_missing'] ?? 0),
        ];
    }

    private function saveCamera(?int $id, array $body): array
    {
        $name = trim((string) ($body['name'] ?? ''));
        $source = $this->validateSource((string) ($body['source_path'] ?? ''));
        $timezone = trim((string) ($body['timezone'] ?? $this->config['timezone']));
        if ($name === '') {
            throw new HttpException(422, 'Camera name is required');
        }
        try {
            new DateTimeZone($timezone);
        } catch (\Throwable) {
            throw new HttpException(422, 'Invalid timezone');
        }
        $offset = (float) ($body['time_offset_seconds'] ?? 0);
        if (!is_finite($offset) || $offset < -3600 || $offset > 3600) {
            throw new HttpException(422, 'Invalid recording time offset');
        }
        $mode = (string) ($body['indexing_mode'] ?? 'partitioned');
        if (!in_array($mode, ['partitioned', 'full'], true)) {
            throw new HttpException(422, 'Invalid indexing mode');
        }
        $pattern = $this->indexer->validatePattern((string) ($body['directory_pattern'] ?? '{YYYY}/{MM}/{DD}'));
        $haEvents = (string) ($body['ha_event_entities'] ?? '');
        $position = (string) ($body['event_overlay_position'] ?? 'top-right');

        $this->db->beginTransaction();
        try {
            if ($id === null) {
                $stmt = $this->db->prepare(<<<'SQL'
INSERT INTO cameras (name, source_path, timezone, time_offset_seconds, indexing_mode, directory_pattern, ha_event_entities, event_overlay_position, source_status)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unknown')
SQL);
                $stmt->execute([$name, $source, $timezone, $offset, $mode, $pattern, $haEvents, $position]);
                $id = (int) $this->db->lastInsertId();
            } else {
                $previous = $this->camera($id);
                $changedSource = $previous['source_path'] !== $source
                    || $previous['indexing_mode'] !== $mode
                    || $previous['directory_pattern'] !== $pattern
                    || $previous['timezone'] !== $timezone;
                $stmt = $this->db->prepare(<<<'SQL'
UPDATE cameras SET name=?, source_path=?, timezone=?, time_offset_seconds=?, indexing_mode=?, directory_pattern=?, ha_event_entities=?, event_overlay_position=?, source_status=?, source_error=NULL WHERE id=?
SQL);
                $stmt->execute([$name, $source, $timezone, $offset, $mode, $pattern, $haEvents, $position, $changedSource ? 'unknown' : $previous['source_status'], $id]);
                if ($stmt->rowCount() === 0 && !$this->existsCamera($id)) {
                    throw new HttpException(404, 'Camera not found');
                }
                if ($changedSource) {
                    $this->db->prepare('DELETE FROM recordings WHERE camera_id=?')->execute([$id]);
                    $this->db->prepare('DELETE FROM partitions WHERE camera_id=?')->execute([$id]);
                }
            }
            $this->db->commit();
        } catch (\Throwable $error) {
            $this->db->rollBack();
            if ($error instanceof \PDOException && str_contains($error->getMessage(), 'UNIQUE')) {
                throw new HttpException(409, 'A camera with this source path already exists');
            }
            throw $error;
        }
        return $this->camera($id);
    }

    private function existsCamera(int $id): bool
    {
        $stmt = $this->db->prepare('SELECT 1 FROM cameras WHERE id=?');
        $stmt->execute([$id]);
        return (bool) $stmt->fetchColumn();
    }

    private function validateSource(string $source): string
    {
        $real = str_contains($source, "\0") ? false : realpath($source);
        if ($real === false || !is_dir($real) || !is_readable($real)) {
            throw new HttpException(422, 'Source directory does not exist or is not readable');
        }
        if (SourcePaths::resolve($real, $this->config['source_roots']) !== null) {
            return $real;
        }
        throw new HttpException(403, 'Source path is outside the configured source roots');
    }

    private function sourceDirectories(?string $requested): array
    {
        if ($this->config['source_roots'] === []) {
            throw new HttpException(404, 'No source roots configured');
        }
        $selected = $this->validateSource($requested ?: $this->config['source_roots'][0]);
        $root = null;
        foreach ($this->config['source_roots'] as $candidate) {
            $candidateReal = realpath($candidate);
            if ($candidateReal !== false && ($selected === $candidateReal || str_starts_with($selected, $candidateReal . DIRECTORY_SEPARATOR))) {
                $root = $candidateReal;
                break;
            }
        }
        $entries = [];
        foreach (new \DirectoryIterator($selected) as $entry) {
            if ($entry->isDot() || !$entry->isDir()) {
                continue;
            }
            $entryPath = SourcePaths::resolve($entry->getPathname(), $this->config['source_roots']);
            if ($entryPath !== null) {
                $entries[] = ['name' => $entry->getFilename(), 'path' => $entryPath];
            }
        }
        usort($entries, static fn (array $a, array $b): int => strcasecmp($a['name'], $b['name']));
        return [
            'root' => $root,
            'path' => $selected,
            'parent' => $selected !== $root ? dirname($selected) : null,
            'entries' => $entries,
        ];
    }

    private function timelineBounds(): array
    {
        $row = $this->db->query(<<<'SQL'
SELECT MIN(r.start_ts + c.time_offset_seconds) AS first,
       MAX(COALESCE(r.end_ts, r.start_ts) + c.time_offset_seconds) AS last
FROM recordings r JOIN cameras c ON c.id=r.camera_id
WHERE r.availability='available'
SQL)->fetch();
        return [
            'first' => $row && $row['first'] !== null ? (float) $row['first'] : null,
            'last' => $row && $row['last'] !== null ? (float) $row['last'] : null,
        ];
    }

    private function prepareTimeline(): array
    {
        $from = $this->requiredFloat('from');
        $to = $this->requiredFloat('to');
        if ($to <= $from || ($to - $from) > 172800) {
            throw new HttpException(422, 'Timeline preparation is limited to 48 hours');
        }
        $ids = $this->cameraIds($_GET['cameras'] ?? '');
        $cameras = $this->selectedCameras($ids);
        $partitions = 0;
        $failed = 0;
        foreach ($cameras as $camera) {
            if ($camera['indexing_mode'] !== 'partitioned') {
                continue;
            }
            foreach ($this->daysForRange($from - $camera['time_offset_seconds'], $to - $camera['time_offset_seconds'], $camera['timezone']) as $day) {
                try {
                    $this->indexer->indexPartition($camera, $day);
                } catch (\Throwable $error) {
                    // One unavailable camera must not hide healthy cameras.
                    error_log('[ctv_php] Partition scan failed: ' . $error->getMessage());
                    $failed++;
                }
                $partitions++;
            }
        }
        return ['status' => 'ready', 'partitions' => 0, 'indexed_partitions' => $partitions - $failed, 'failed_partitions' => $failed];
    }

    private function timeline(): array
    {
        $bounds = $this->timelineBounds();
        $from = isset($_GET['from']) ? $this->requiredFloat('from') : ($bounds['first'] ?? 0.0);
        $to = isset($_GET['to']) ? $this->requiredFloat('to') : ($bounds['last'] ?? ($from + 86400));
        if ($to < $from) {
            throw new HttpException(422, 'Invalid timeline range');
        }
        $ids = $this->cameraIds($_GET['cameras'] ?? '');
        $cameras = $this->selectedCameras($ids);
        $result = [];
        foreach ($cameras as $camera) {
            $offset = (float) $camera['time_offset_seconds'];
            $stmt = $this->db->prepare(<<<'SQL'
SELECT id, filename, start_ts, end_ts, duration, media_kind, thumbnail_path
FROM recordings
WHERE camera_id=? AND availability='available'
  AND COALESCE(end_ts, start_ts) >= CAST(? AS REAL)
  AND start_ts <= ?
ORDER BY start_ts
SQL);
            $stmt->execute([$camera['id'], $from - $offset, $to - $offset]);
            $segments = [];
            foreach ($stmt as $row) {
                $segments[] = [
                    'id' => (int) $row['id'],
                    'events' => [],
                    'events_status' => 'disabled',
                    'filename' => $row['filename'],
                    'start_ts' => (float) $row['start_ts'] + $offset,
                    'end_ts' => $row['end_ts'] !== null ? (float) $row['end_ts'] + $offset : null,
                    'duration' => (float) $row['duration'],
                    'media_kind' => $row['media_kind'],
                    'has_thumbnail' => $row['thumbnail_path'] !== null && is_file($row['thumbnail_path']),
                ];
            }
            $state = 'ready';
            if ($camera['indexing_mode'] === 'partitioned') {
                $zone = new DateTimeZone($camera['timezone']);
                $firstDay = (new DateTimeImmutable('@' . (int) floor($from - $offset)))->setTimezone($zone)->format('Y-m-d');
                $lastDay = (new DateTimeImmutable('@' . (int) floor(max($from - $offset, $to - $offset - 0.001))))->setTimezone($zone)->format('Y-m-d');
                $partitions = $this->db->prepare('SELECT status FROM partitions WHERE camera_id=? AND partition_key BETWEEN ? AND ?');
                $partitions->execute([$camera['id'], $firstDay, $lastDay]);
                $statuses = $partitions->fetchAll(PDO::FETCH_COLUMN);
                if (in_array('scanning', $statuses, true)) {
                    $state = 'scanning';
                } elseif (in_array('error', $statuses, true)) {
                    $state = 'error';
                } elseif ($statuses === []) {
                    $state = 'unknown';
                } elseif (count(array_filter($statuses, static fn ($status) => $status === 'missing')) === count($statuses)) {
                    $state = 'missing';
                }
            }
            $result[] = [
                'camera_id' => (int) $camera['id'],
                'camera_name' => $camera['name'],
                'partition_status' => $state,
                'progress_done' => 0,
                'progress_total' => 0,
                'segments' => $segments,
            ];
        }
        return ['from' => $from, 'to' => $to, 'cameras' => $result];
    }

    private function listRecordings(): array
    {
        $conditions = ["r.availability='available'"];
        $params = [];
        if (isset($_GET['camera_id'])) {
            $conditions[] = 'r.camera_id=?';
            $params[] = (int) $_GET['camera_id'];
        }
        if (isset($_GET['from'])) {
            $conditions[] = 'COALESCE(r.end_ts,r.start_ts)+c.time_offset_seconds>=CAST(? AS REAL)';
            $params[] = (float) $_GET['from'];
        }
        if (isset($_GET['to'])) {
            $conditions[] = 'r.start_ts+c.time_offset_seconds<=CAST(? AS REAL)';
            $params[] = (float) $_GET['to'];
        }
        $limit = max(1, min(1000, (int) ($_GET['limit'] ?? 100)));
        $offset = max(0, (int) ($_GET['offset'] ?? 0));
        $sql = 'SELECT r.*,c.time_offset_seconds FROM recordings r JOIN cameras c ON c.id=r.camera_id WHERE '
            . implode(' AND ', $conditions) . ' ORDER BY r.start_ts LIMIT ? OFFSET ?';
        $stmt = $this->db->prepare($sql);
        $stmt->execute([...$params, $limit, $offset]);
        return array_map([$this, 'publicRecording'], $stmt->fetchAll());
    }

    private function recording(int $id): array
    {
        return $this->publicRecording($this->recordingRow($id));
    }

    private function recordingRow(int $id): array
    {
        $sql = 'SELECT r.*,c.time_offset_seconds,c.source_path AS camera_source_path FROM recordings r JOIN cameras c ON c.id=r.camera_id WHERE r.id=?';
        $stmt = $this->db->prepare($sql);
        $stmt->execute([$id]);
        $row = $stmt->fetch();
        if (!$row) {
            throw new HttpException(404, 'Recording not found');
        }
        return $row;
    }

    private function publicRecording(array $row): array
    {
        $offset = (float) ($row['time_offset_seconds'] ?? 0);
        return [
            'id' => (int) $row['id'],
            'camera_id' => (int) $row['camera_id'],
            'filename' => $row['filename'],
            'start_ts' => (float) $row['start_ts'] + $offset,
            'end_ts' => $row['end_ts'] !== null ? (float) $row['end_ts'] + $offset : null,
            'duration' => (float) $row['duration'],
            'codec' => $row['codec'],
            'resolution' => $row['resolution'],
            'fps' => (float) $row['fps'],
            'size' => (int) $row['size'],
            'media_kind' => $row['media_kind'],
            'availability' => $row['availability'],
        ];
    }

    private function search(): array
    {
        $query = trim((string) ($_GET['q'] ?? ''));
        $limit = max(1, min(500, (int) ($_GET['limit'] ?? 100)));
        $conditions = ["r.availability='available'"];
        $params = [];
        if ($query !== '') {
            $conditions[] = '(r.filename LIKE ? OR c.name LIKE ?)';
            $params[] = '%' . $query . '%';
            $params[] = '%' . $query . '%';
        }
        if (isset($_GET['camera_id'])) {
            $conditions[] = 'r.camera_id=?';
            $params[] = (int) $_GET['camera_id'];
        }
        if (isset($_GET['from'])) {
            $conditions[] = 'COALESCE(r.end_ts,r.start_ts)+c.time_offset_seconds>=CAST(? AS REAL)';
            $params[] = (float) $_GET['from'];
        }
        if (isset($_GET['to'])) {
            $conditions[] = 'r.start_ts+c.time_offset_seconds<=CAST(? AS REAL)';
            $params[] = (float) $_GET['to'];
        }
        if (isset($_GET['min_duration'])) {
            $conditions[] = 'r.duration>=?';
            $params[] = (float) $_GET['min_duration'];
        }
        $stmt = $this->db->prepare(
            'SELECT r.*,c.name AS camera_name,c.time_offset_seconds FROM recordings r JOIN cameras c ON c.id=r.camera_id WHERE '
            . implode(' AND ', $conditions) . ' ORDER BY r.start_ts DESC LIMIT ?'
        );
        $stmt->execute([...$params, $limit]);
        $rows = [];
        foreach ($stmt as $row) {
            $offset = (float) $row['time_offset_seconds'];
            $rows[] = [
                'id' => (int) $row['id'],
                'camera_id' => (int) $row['camera_id'],
                'camera_name' => $row['camera_name'],
                'filename' => $row['filename'],
                'start_ts' => (float) $row['start_ts'] + $offset,
                'end_ts' => $row['end_ts'] !== null ? (float) $row['end_ts'] + $offset : null,
                'duration' => (float) $row['duration'],
            ];
        }
        return $rows;
    }

    private function selectedCameras(array $ids): array
    {
        if ($ids === []) {
            return $this->listCameras();
        }
        $placeholders = implode(',', array_fill(0, count($ids), '?'));
        $stmt = $this->db->prepare("SELECT * FROM cameras WHERE id IN ($placeholders) ORDER BY name");
        $stmt->execute($ids);
        return array_map([$this, 'publicCamera'], $stmt->fetchAll());
    }

    private function cameraIds(string $value): array
    {
        return array_values(array_filter(array_map('intval', explode(',', $value)), static fn (int $id): bool => $id > 0));
    }

    private function requiredFloat(string $name): float
    {
        if (!isset($_GET[$name]) || !is_numeric($_GET[$name]) || !is_finite((float) $_GET[$name])
            || (float) $_GET[$name] < -62135596800 || (float) $_GET[$name] > 253402300799) {
            throw new HttpException(422, 'Missing or invalid ' . $name);
        }
        return (float) $_GET[$name];
    }

    /** @return list<string> */
    private function daysForRange(float $from, float $to, string $timezone): array
    {
        $zone = new DateTimeZone($timezone);
        $start = (new DateTimeImmutable('@' . (int) floor($from)))->setTimezone($zone)->setTime(0, 0);
        $end = (new DateTimeImmutable('@' . (int) floor(max($from, $to - 0.001))))->setTimezone($zone)->setTime(0, 0);
        $days = [];
        for ($day = $start; $day <= $end; $day = $day->modify('+1 day')) {
            $days[] = $day->format('Y-m-d');
        }
        return $days;
    }

    private function todayForCamera(array $camera): string
    {
        return (new DateTimeImmutable('now', new DateTimeZone($camera['timezone'])))->format('Y-m-d');
    }
}
