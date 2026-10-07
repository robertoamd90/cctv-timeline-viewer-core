<?php

declare(strict_types=1);

namespace CtvPhp;

use PDO;

final class Database
{
    private PDO $pdo;

    public function __construct(string $path)
    {
        $this->pdo = new PDO('sqlite:' . $path, null, null, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]);
        $this->pdo->exec('PRAGMA foreign_keys = ON');
        $this->pdo->exec('PRAGMA busy_timeout = 5000');
        $this->migrate();
    }

    public function pdo(): PDO
    {
        return $this->pdo;
    }

    private function migrate(): void
    {
        $this->pdo->exec(<<<'SQL'
CREATE TABLE IF NOT EXISTS cameras (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    source_path TEXT NOT NULL UNIQUE,
    timezone TEXT NOT NULL DEFAULT 'Europe/Zurich',
    time_offset_seconds REAL NOT NULL DEFAULT 0,
    indexing_mode TEXT NOT NULL DEFAULT 'partitioned',
    directory_pattern TEXT NOT NULL DEFAULT '{YYYY}/{MM}/{DD}',
    ha_event_entities TEXT NOT NULL DEFAULT '',
    event_overlay_position TEXT NOT NULL DEFAULT 'top-right',
    source_status TEXT NOT NULL DEFAULT 'unknown',
    source_error TEXT,
    last_scan_started REAL,
    last_scan_completed REAL
);

CREATE TABLE IF NOT EXISTS recordings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    camera_id INTEGER NOT NULL,
    path TEXT NOT NULL,
    filename TEXT NOT NULL,
    start_ts REAL NOT NULL,
    end_ts REAL,
    duration REAL NOT NULL DEFAULT 0,
    codec TEXT NOT NULL DEFAULT '',
    resolution TEXT NOT NULL DEFAULT '',
    fps REAL NOT NULL DEFAULT 0,
    size INTEGER NOT NULL DEFAULT 0,
    mtime REAL NOT NULL DEFAULT 0,
    thumbnail_path TEXT,
    partition_key TEXT,
    media_kind TEXT NOT NULL DEFAULT 'video',
    availability TEXT NOT NULL DEFAULT 'available',
    UNIQUE(camera_id, path),
    FOREIGN KEY(camera_id) REFERENCES cameras(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_recordings_camera_start ON recordings(camera_id, start_ts);
CREATE INDEX IF NOT EXISTS idx_recordings_camera_partition_start ON recordings(camera_id, partition_key, start_ts);
CREATE INDEX IF NOT EXISTS idx_recordings_availability ON recordings(availability);

CREATE TABLE IF NOT EXISTS partitions (
    camera_id INTEGER NOT NULL,
    partition_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'unknown',
    progress_done INTEGER NOT NULL DEFAULT 0,
    progress_total INTEGER NOT NULL DEFAULT 0,
    last_scanned REAL,
    PRIMARY KEY(camera_id, partition_key),
    FOREIGN KEY(camera_id) REFERENCES cameras(id) ON DELETE CASCADE
);
SQL);
    }
}
