"""Persistent per-camera schedules. Only today's physical directory is inspected."""
import time
from datetime import datetime
from zoneinfo import ZoneInfo

from ctv_server.db import get_db, write_db
from ctv_server.operations import index_generation
from ctv_server.partitioner import partition_key, resolve_partition
from ctv_server.partition_service import run_partition_scan


def recover_interrupted_scans():
    """Called once at startup, before accepting new indexing requests."""
    with write_db() as conn:
        conn.execute("UPDATE partitions SET status='unknown', error=NULL WHERE status IN ('queued','scanning','background')")
        conn.execute("UPDATE cameras SET source_status='unknown' WHERE source_status='scanning'")


def run_due_autoscans(stop=None):
    conn = get_db()
    try:
        ids = [row[0] for row in conn.execute(
            "SELECT id FROM cameras WHERE autoscan_enabled=1 AND indexing_mode='partitioned' ORDER BY autoscan_last_attempt, id"
        )]
    finally:
        conn.close()
    for camera_id in ids:
        if stop is not None and stop.is_set():
            return
        now = time.time()
        generation = index_generation()
        with write_db() as conn:
            camera = conn.execute("SELECT * FROM cameras WHERE id=?", (camera_id,)).fetchone()
            if not camera or not camera['autoscan_enabled'] or camera['indexing_mode'] != 'partitioned':
                continue
            day = datetime.fromtimestamp(now, ZoneInfo(camera['timezone'])).date()
            key = partition_key(day)
            last = camera['autoscan_last_attempt']
            if camera['autoscan_last_day'] == key and last is not None and now-last < camera['autoscan_interval_minutes']*60:
                continue
            path = resolve_partition(camera['source_path'], camera['directory_pattern'], day)
            row = conn.execute("SELECT status FROM partitions WHERE camera_id=? AND partition_key=?", (camera_id,key)).fetchone()
            if row and row['status'] in ('queued', 'scanning', 'background'):
                continue
            conn.execute("INSERT INTO partitions(camera_id,partition_key,path,status) VALUES(?,?,?,'unknown') ON CONFLICT(camera_id,partition_key) DO UPDATE SET path=excluded.path", (camera_id,key,path))
        result = run_partition_scan(camera_id,key,path,generation,incremental=True)
        if result['status'] == 'busy':
            continue
        # Count failures too: an offline NAS must not be hammered every scheduler tick.
        with write_db() as conn:
            conn.execute("UPDATE cameras SET autoscan_last_attempt=?, autoscan_last_day=? WHERE id=? AND source_path=? AND directory_pattern=? AND timezone=?", (time.time(),key,camera_id,camera['source_path'],camera['directory_pattern'],camera['timezone']))
