import sqlite3
import os
import threading
import logging
from collections.abc import Iterable
from contextlib import contextmanager

DB_PATH = os.environ.get("CTV_DB", os.path.expanduser("~/.ctv/ctv.db"))
_WRITE_LOCK = threading.Lock()
_ANCHOR_LOCK = threading.Lock()
_ANCHOR_CONNECTION = None
log = logging.getLogger("ctv.db")
RECORDING_TIME_DELTA_SQL = (
    "COALESCE(c.time_offset_seconds, 0)"
)
# 128-second buckets cover the complete practical datetime range while exact
# predicates keep the public interval semantics at sub-second precision.
RANGE_BUCKET_SECONDS = 128
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


def _keep_wal_open(conn: sqlite3.Connection):
    """Keep WAL shared state warm instead of recreating it for every request."""
    global _ANCHOR_CONNECTION
    with _ANCHOR_LOCK:
        previous = _ANCHOR_CONNECTION
        _ANCHOR_CONNECTION = conn
    if previous is not None and previous is not conn:
        previous.close()


def close_db():
    """Close process-wide SQLite state during application shutdown."""
    global _ANCHOR_CONNECTION
    with _ANCHOR_LOCK:
        connection = _ANCHOR_CONNECTION
        _ANCHOR_CONNECTION = None
    if connection is not None:
        connection.close()


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


def _range_bucket_sql(value: str, *, upper: bool) -> str:
    """Return an outward-rounded integer bucket expression for an SQL value."""
    scaled = f"(({value}) / {RANGE_BUCKET_SECONDS}.0)"
    integer = f"CAST({scaled} AS INTEGER)"
    comparison = ">" if upper else "<"
    adjustment = "+" if upper else "-"
    return f"({integer} {adjustment} ({scaled} {comparison} {integer}))"


def _set_recording_range_state(
    conn: sqlite3.Connection, value: str, error=None,
):
    conn.execute(
        "INSERT OR REPLACE INTO schema_state (key, value) "
        "VALUES ('recording_ranges_ready', ?)",
        (value,),
    )
    if error:
        conn.execute(
            "INSERT OR REPLACE INTO schema_state (key, value) "
            "VALUES ('recording_ranges_error', ?)",
            (error,),
        )
    else:
        conn.execute("DELETE FROM schema_state WHERE key = 'recording_ranges_error'")


def disable_recording_range_index(conn: sqlite3.Connection, error=None):
    """Remove write hooks so a broken derived index cannot block core writes."""
    for trigger in _RANGE_TRIGGER_NAMES:
        conn.execute(f"DROP TRIGGER IF EXISTS {trigger}")
    _set_recording_range_state(conn, "unavailable", error)


def sqlite_error_details(exc: sqlite3.Error) -> str:
    name = getattr(exc, "sqlite_errorname", None)
    code = getattr(exc, "sqlite_errorcode", None)
    suffix = f" ({name}/{code})" if name or code is not None else ""
    return f"{exc}{suffix}"


def recording_range_status() -> dict:
    conn = get_db()
    try:
        values = {
            row["key"]: row["value"]
            for row in conn.execute(
                "SELECT key, value FROM schema_state "
                "WHERE key IN ('recording_ranges_ready', 'recording_ranges_error')"
            )
        }
    finally:
        conn.close()
    ready = values.get("recording_ranges_ready") == "1"
    return {
        "status": "ready" if ready else "fallback",
        "error": None if ready else values.get("recording_ranges_error"),
    }


def _probe_recording_range_index(conn: sqlite3.Connection):
    """Exercise an R-Tree write and roll it back without changing derived data."""
    conn.execute("SAVEPOINT recording_ranges_probe")
    try:
        conn.execute(
            "INSERT OR REPLACE INTO recording_ranges VALUES (?, 0, 0, 0, 0)",
            (-2_147_483_648,),
        )
        conn.execute(
            "DELETE FROM recording_ranges WHERE recording_id = ?",
            (-2_147_483_648,),
        )
    except sqlite3.Error:
        conn.execute("ROLLBACK TO recording_ranges_probe")
        conn.execute("RELEASE recording_ranges_probe")
        raise
    conn.execute("ROLLBACK TO recording_ranges_probe")
    conn.execute("RELEASE recording_ranges_probe")


def _init_recording_range_index(conn: sqlite3.Connection) -> bool:
    """Create a derived interval index, falling back safely if it is unusable."""
    ready = conn.execute(
        "SELECT value FROM schema_state WHERE key = 'recording_ranges_ready'"
    ).fetchone()
    exists = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'recording_ranges'"
    ).fetchone()
    if not exists:
        try:
            conn.execute("""
                CREATE VIRTUAL TABLE recording_ranges USING rtree_i32(
                    recording_id,
                    camera_id_min, camera_id_max,
                    start_bucket, end_bucket
                )
            """)
        except sqlite3.OperationalError as exc:
            detail = sqlite_error_details(exc)
            if "no such module" not in str(exc).lower():
                log.warning("Recording range index unavailable: %s", detail)
            disable_recording_range_index(conn, detail)
            return False

    start_value = "MIN(NEW.start_ts, COALESCE(NEW.end_ts, NEW.start_ts))"
    end_value = "MAX(NEW.start_ts, COALESCE(NEW.end_ts, NEW.start_ts))"
    start_bucket = _range_bucket_sql(start_value, upper=False)
    end_bucket = _range_bucket_sql(end_value, upper=True)
    conn.executescript(f"""
        CREATE TRIGGER IF NOT EXISTS recordings_range_insert
        AFTER INSERT ON recordings
        BEGIN
            INSERT OR REPLACE INTO recording_ranges VALUES (
                NEW.id, NEW.camera_id, NEW.camera_id, {start_bucket}, {end_bucket}
            );
        END;

        CREATE TRIGGER IF NOT EXISTS recordings_range_update
        AFTER UPDATE OF camera_id, start_ts, end_ts ON recordings
        BEGIN
            DELETE FROM recording_ranges WHERE recording_id = OLD.id;
            INSERT OR REPLACE INTO recording_ranges VALUES (
                NEW.id, NEW.camera_id, NEW.camera_id, {start_bucket}, {end_bucket}
            );
        END;

        CREATE TRIGGER IF NOT EXISTS recordings_range_delete
        AFTER DELETE ON recordings
        BEGIN
            DELETE FROM recording_ranges WHERE recording_id = OLD.id;
        END;
    """)
    if not ready or ready["value"] != "1":
        conn.execute("DELETE FROM recording_ranges")
        source_start = _range_bucket_sql(
            "MIN(start_ts, COALESCE(end_ts, start_ts))", upper=False,
        )
        source_end = _range_bucket_sql(
            "MAX(start_ts, COALESCE(end_ts, start_ts))", upper=True,
        )
        conn.execute(f"""
            INSERT INTO recording_ranges
            SELECT id, camera_id, camera_id, {source_start}, {source_end}
            FROM recordings
        """)
        _set_recording_range_state(conn, "1")
    try:
        _probe_recording_range_index(conn)
    except sqlite3.Error as exc:
        detail = sqlite_error_details(exc)
        log.warning("Recording range index write probe failed: %s", detail)
        disable_recording_range_index(conn, detail)
        return False
    _set_recording_range_state(conn, "1")
    return True


def reset_recording_range_index() -> bool:
    """Replace the disposable R-Tree without making core data depend on success."""
    try:
        with write_db() as conn:
            disable_recording_range_index(conn)
            conn.execute("DROP TABLE IF EXISTS recording_ranges")
        with write_db() as conn:
            return _init_recording_range_index(conn)
    except sqlite3.Error as exc:
        detail = sqlite_error_details(exc)
        log.warning("Recording range index reset failed: %s", detail)
        # DROP can fail for a damaged virtual table.  Dropping the hooks in a
        # separate transaction still restores normal writes and SQL fallback.
        with write_db() as conn:
            disable_recording_range_index(conn, detail)
        return False


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
        "indexing_mode TEXT NOT NULL DEFAULT 'partitioned'",
        "directory_pattern TEXT NOT NULL DEFAULT '{YYYY}/{MM}/{DD}'",
        "source_status TEXT NOT NULL DEFAULT 'unknown'",
        "source_error TEXT",
        "last_scan_started REAL",
        "last_scan_completed REAL",
    ))
    _add_columns(conn, "recordings", (
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
    _init_recording_range_index(conn)
    _init_recording_counts(conn)
    conn.commit()
    _keep_wal_open(conn)
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
