import sqlite3
import os
import tempfile
import threading
from collections.abc import Iterable
from contextlib import contextmanager

DB_PATH = os.environ.get("CTV_DB", os.path.expanduser("~/.ctv/ctv.db"))
_WRITE_LOCK = threading.Lock()
RECORDING_TIME_DELTA_SQL = (
    "COALESCE(c.time_offset_seconds, 0)"
)
_RANGE_TRIGGER_NAMES = (
    "recordings_range_insert",
    "recordings_range_update",
    "recordings_range_delete",
)


def recording_time_delta(row) -> float:
    keys = row.keys()
    configured = row["time_offset_seconds"] if "time_offset_seconds" in keys else 0
    return configured or 0


def get_db() -> sqlite3.Connection:
    """Create a short-lived SQLite connection with per-connection settings."""
    os.makedirs(os.path.dirname(os.path.abspath(DB_PATH)), exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=30000")
    return conn


def close_db():
    """Compatibility hook: database connections are all short-lived."""


@contextmanager
def write_db():
    """Serialize SQLite writers while allowing WAL readers to continue."""
    with _WRITE_LOCK:
        conn = get_db()
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}


def _add_columns(conn: sqlite3.Connection, table: str, definitions: Iterable[str]):
    existing = _columns(conn, table)
    for definition in definitions:
        name = definition.split()[0]
        if name not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {definition}")


def retire_recording_range_index(conn: sqlite3.Connection):
    """Detach the former R-Tree so it can no longer affect core writes."""
    for trigger in _RANGE_TRIGGER_NAMES:
        conn.execute(f"DROP TRIGGER IF EXISTS {trigger}")
    # Do not open or drop the derived virtual table here.  A damaged R-Tree is
    # precisely what this migration must isolate; with its triggers removed it
    # is inert and can safely remain as unused legacy data.
    conn.execute(
        "INSERT OR REPLACE INTO schema_state (key, value) "
        "VALUES ('recording_ranges_ready', 'retired')"
    )
    conn.execute("DELETE FROM schema_state WHERE key = 'recording_ranges_error'")


def sqlite_error_details(exc: sqlite3.Error) -> str:
    name = getattr(exc, "sqlite_errorname", None)
    code = getattr(exc, "sqlite_errorcode", None)
    suffix = f" ({name}/{code})" if name or code is not None else ""
    return f"{exc}{suffix}"


def _verify_sqlite_temp_directory():
    """Fail at startup with a precise error if the configured VFS temp path is denied."""
    directory = os.environ.get("SQLITE_TMPDIR")
    if not directory:
        return
    try:
        with tempfile.TemporaryFile(dir=directory) as probe:
            probe.write(b"ctv")
            probe.flush()
    except OSError as exc:
        raise RuntimeError(
            f"SQLite temporary directory is not writable: {directory}: {exc}"
        ) from exc


def _init_recording_counts(conn: sqlite3.Connection):
    """Maintain camera counters incrementally instead of grouping the full archive."""
    conn.executescript("""
        CREATE TRIGGER IF NOT EXISTS recordings_count_insert
        AFTER INSERT ON recordings
        BEGIN
            INSERT INTO camera_recording_counts (
                camera_id, recordings_available, recordings_missing
            ) VALUES (
                NEW.camera_id,
                CASE WHEN NEW.availability = 'available' THEN 1 ELSE 0 END,
                CASE WHEN NEW.availability = 'missing' THEN 1 ELSE 0 END
            )
            ON CONFLICT(camera_id) DO UPDATE SET
                recordings_available = recordings_available + excluded.recordings_available,
                recordings_missing = recordings_missing + excluded.recordings_missing;
        END;

        CREATE TRIGGER IF NOT EXISTS recordings_count_delete
        AFTER DELETE ON recordings
        BEGIN
            UPDATE camera_recording_counts SET
                recordings_available = MAX(0, recordings_available -
                    CASE WHEN OLD.availability = 'available' THEN 1 ELSE 0 END),
                recordings_missing = MAX(0, recordings_missing -
                    CASE WHEN OLD.availability = 'missing' THEN 1 ELSE 0 END)
            WHERE camera_id = OLD.camera_id;
        END;

        CREATE TRIGGER IF NOT EXISTS recordings_count_update
        AFTER UPDATE OF camera_id, availability ON recordings
        WHEN OLD.camera_id IS NOT NEW.camera_id OR OLD.availability IS NOT NEW.availability
        BEGIN
            UPDATE camera_recording_counts SET
                recordings_available = MAX(0, recordings_available -
                    CASE WHEN OLD.availability = 'available' THEN 1 ELSE 0 END),
                recordings_missing = MAX(0, recordings_missing -
                    CASE WHEN OLD.availability = 'missing' THEN 1 ELSE 0 END)
            WHERE camera_id = OLD.camera_id;
            INSERT INTO camera_recording_counts (
                camera_id, recordings_available, recordings_missing
            ) VALUES (
                NEW.camera_id,
                CASE WHEN NEW.availability = 'available' THEN 1 ELSE 0 END,
                CASE WHEN NEW.availability = 'missing' THEN 1 ELSE 0 END
            )
            ON CONFLICT(camera_id) DO UPDATE SET
                recordings_available = recordings_available + excluded.recordings_available,
                recordings_missing = recordings_missing + excluded.recordings_missing;
        END;
    """)
    ready = conn.execute(
        "SELECT value FROM schema_state WHERE key = 'recording_counts_ready'"
    ).fetchone()
    if not ready or ready["value"] != "1":
        conn.execute("DELETE FROM camera_recording_counts")
        conn.execute("""
            INSERT INTO camera_recording_counts (
                camera_id, recordings_available, recordings_missing
            )
            SELECT camera_id,
                   SUM(CASE WHEN availability = 'available' THEN 1 ELSE 0 END),
                   SUM(CASE WHEN availability = 'missing' THEN 1 ELSE 0 END)
            FROM recordings GROUP BY camera_id
        """)
        conn.execute(
            "INSERT OR REPLACE INTO schema_state (key, value) "
            "VALUES ('recording_counts_ready', '1')"
        )


def init_db():
    """Inizializza schema DB (idempotente)."""
    _verify_sqlite_temp_directory()
    conn = get_db()
    # WAL is persistent database state. Setting it once at startup avoids a
    # filesystem lock and journal probe on every request connection.
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS cameras (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            source_path TEXT NOT NULL,
            timezone TEXT DEFAULT 'UTC',
            time_offset_seconds REAL NOT NULL DEFAULT 0,
            config TEXT DEFAULT '{}',
            indexing_mode TEXT NOT NULL DEFAULT 'partitioned',
            directory_pattern TEXT NOT NULL DEFAULT '{YYYY}/{MM}/{DD}',
            source_status TEXT NOT NULL DEFAULT 'unknown',
            source_error TEXT,
            last_scan_started REAL,
            last_scan_completed REAL
        );

        CREATE TABLE IF NOT EXISTS recordings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            camera_id INTEGER NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
            path TEXT NOT NULL,
            filename TEXT NOT NULL,
            start_ts REAL NOT NULL,
            end_ts REAL,
            duration REAL,
            codec TEXT,
            resolution TEXT,
            fps REAL,
            size INTEGER,
            mtime REAL,
            hash TEXT,
            thumbnail_path TEXT,
            metadata TEXT DEFAULT '{}',
            partition_key TEXT,
            media_kind TEXT NOT NULL DEFAULT 'video',
            availability TEXT NOT NULL DEFAULT 'available',
            last_seen REAL,
            UNIQUE(camera_id, path)
        );

        CREATE INDEX IF NOT EXISTS idx_recordings_camera ON recordings(camera_id);
        CREATE INDEX IF NOT EXISTS idx_recordings_start ON recordings(start_ts);
        CREATE INDEX IF NOT EXISTS idx_recordings_range ON recordings(camera_id, start_ts, end_ts);
        CREATE INDEX IF NOT EXISTS idx_recordings_end
            ON recordings(camera_id, COALESCE(end_ts, start_ts) DESC);

        CREATE TABLE IF NOT EXISTS partitions (
            camera_id INTEGER NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
            partition_key TEXT NOT NULL,
            path TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'unknown',
            error TEXT,
            last_requested REAL,
            last_scanned REAL,
            file_count INTEGER NOT NULL DEFAULT 0,
            progress_done INTEGER NOT NULL DEFAULT 0,
            progress_total INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(camera_id, partition_key)
        );
        CREATE INDEX IF NOT EXISTS idx_partitions_requested ON partitions(last_requested);

        CREATE TABLE IF NOT EXISTS stream_profiles (
            name TEXT PRIMARY KEY,
            scale_percent INTEGER NOT NULL,
            fps INTEGER NOT NULL,
            bitrate_kbps INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS playback_settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            max_transcoders INTEGER NOT NULL,
            hls_temp_mb INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS schema_state (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS camera_recording_counts (
            camera_id INTEGER PRIMARY KEY REFERENCES cameras(id) ON DELETE CASCADE,
            recordings_available INTEGER NOT NULL DEFAULT 0,
            recordings_missing INTEGER NOT NULL DEFAULT 0
        );
    """)
    conn.execute(
        "INSERT OR IGNORE INTO playback_settings VALUES (1, ?, ?)",
        (max(0, int(os.environ.get("CTV_MAX_TRANSCODERS", "0"))),
         max(16, int(os.environ.get("CTV_HLS_TEMP_MB", "256")))),
    )
    conn.executemany(
        """
        INSERT OR IGNORE INTO stream_profiles (name, scale_percent, fps, bitrate_kbps)
        VALUES (?, ?, ?, ?)
        """,
        (
            ("balanced", 50, 15, 1200),
            ("fast", 30, 8, 450),
        ),
    )
    # Migrazioni additive per database creati dalle versioni PoC.
    _add_columns(conn, "cameras", (
        "time_offset_seconds REAL NOT NULL DEFAULT 0",
        "ha_event_entities TEXT NOT NULL DEFAULT ''",
        "autoscan_enabled INTEGER NOT NULL DEFAULT 0",
        "autoscan_interval_minutes INTEGER NOT NULL DEFAULT 60",
        "autoscan_last_attempt REAL",
        "autoscan_last_day TEXT",
        "event_overlay_position TEXT NOT NULL DEFAULT 'top-right'",
        "indexing_mode TEXT NOT NULL DEFAULT 'partitioned'",
        "directory_pattern TEXT NOT NULL DEFAULT '{YYYY}/{MM}/{DD}'",
        "source_status TEXT NOT NULL DEFAULT 'unknown'",
        "source_error TEXT",
        "last_scan_started REAL",
        "last_scan_completed REAL",
    ))
    _add_columns(conn, "recordings", (
        "ha_events TEXT NOT NULL DEFAULT '[]'",
        "ha_events_status TEXT NOT NULL DEFAULT 'pending'",
        "ha_events_checked REAL",
        "ha_events_signature TEXT",
        "autoscan_settled INTEGER NOT NULL DEFAULT 0",
        "ha_events_version INTEGER NOT NULL DEFAULT 1",
        "mtime REAL",
        "partition_key TEXT",
        "media_kind TEXT NOT NULL DEFAULT 'video'",
        "availability TEXT NOT NULL DEFAULT 'available'",
        "last_seen REAL",
    ))
    _add_columns(conn, "partitions", (
        "progress_done INTEGER NOT NULL DEFAULT 0",
        "progress_total INTEGER NOT NULL DEFAULT 0",
    ))
    conn.execute("CREATE INDEX IF NOT EXISTS idx_recordings_availability ON recordings(camera_id, availability)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_recordings_partition ON recordings(camera_id, partition_key)")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_recordings_camera_available_start "
        "ON recordings(camera_id, availability, start_ts)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_recordings_partition_time "
        "ON recordings(camera_id, partition_key, availability, start_ts)"
    )
    # v0.1.27 beta initially used an R-Tree maintained by triggers. Detach it
    # before any recording cleanup so an unusable virtual table cannot block
    # startup, scans or rebuilds on existing databases.
    retire_recording_range_index(conn)
    image_thumbnails = [
        row[0] for row in conn.execute("""
            SELECT thumbnail_path FROM recordings
            WHERE (media_kind = 'image' OR lower(path) LIKE '%.jpg'
                   OR lower(path) LIKE '%.jpeg' OR lower(path) LIKE '%.png')
              AND thumbnail_path IS NOT NULL
        """).fetchall()
    ]
    conn.execute("""
        DELETE FROM recordings
        WHERE media_kind = 'image' OR lower(path) LIKE '%.jpg'
           OR lower(path) LIKE '%.jpeg' OR lower(path) LIKE '%.png'
    """)
    legacy_thumbnails = [
        row[0] for row in conn.execute("""
            SELECT r.thumbnail_path FROM recordings r
            JOIN cameras c ON c.id = r.camera_id
            WHERE c.indexing_mode = 'partitioned' AND r.partition_key IS NULL
              AND r.thumbnail_path IS NOT NULL
        """).fetchall()
    ]
    conn.execute("""
        DELETE FROM recordings
        WHERE partition_key IS NULL
          AND camera_id IN (SELECT id FROM cameras WHERE indexing_mode = 'partitioned')
    """)
    _init_recording_counts(conn)
    conn.commit()
    conn.close()
    for thumbnail in legacy_thumbnails:
        try:
            os.unlink(thumbnail)
        except OSError:
            pass
    for thumbnail in image_thumbnails:
        try:
            os.unlink(thumbnail)
        except OSError:
            pass
