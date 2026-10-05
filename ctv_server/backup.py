"""Consistent online SQLite snapshots for Home Assistant hot backups."""
import os
from pathlib import Path
import sqlite3
import tempfile
import time
import sys
from contextlib import closing


def snapshot_path(database):
    return Path(str(database) + '.backup')


def create_snapshot(database, timeout=25):
    database = Path(database)
    # Never silently create an empty source database.
    source_uri = database.resolve().as_uri() + '?mode=ro'
    target = snapshot_path(database)
    fd, temporary = tempfile.mkstemp(prefix='.ctv-backup-', dir=database.parent)
    os.close(fd)
    deadline = time.monotonic() + timeout
    try:
        def progress(status, remaining, total):
            if time.monotonic() > deadline:
                raise TimeoutError('SQLite backup snapshot timed out')

        with closing(sqlite3.connect(source_uri, uri=True)) as source, closing(sqlite3.connect(temporary)) as output:
            source.backup(output, pages=256, progress=progress, sleep=0.05)
            if output.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                raise RuntimeError('SQLite backup snapshot failed integrity check')
        with open(temporary, 'rb') as handle:
            os.fsync(handle.fileno())
        os.replace(temporary, target)
    finally:
        Path(temporary).unlink(missing_ok=True)
    return target


def restore_snapshot(database):
    database = Path(database)
    snapshot = snapshot_path(database)
    marker = database.parent / '.ctv-live'
    database.parent.mkdir(parents=True, exist_ok=True)
    if not snapshot.exists() or (database.exists() and marker.exists()):
        marker.touch(exist_ok=True)
        return False
    # Restored backups contain only the snapshot, never a live WAL pair.
    with closing(sqlite3.connect(snapshot.resolve().as_uri() + '?mode=ro', uri=True)) as source:
        if source.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
            raise RuntimeError('Restored SQLite snapshot failed integrity check')
    for suffix in ('-wal', '-shm'):
        Path(str(database) + suffix).unlink(missing_ok=True)
    os.replace(snapshot, database)
    marker.touch(exist_ok=True)
    return True


if __name__ == '__main__':
    from ctv_server.db import DB_PATH
    if sys.argv[1:] == ['cleanup']:
        snapshot_path(DB_PATH).unlink(missing_ok=True)
    else:
        print(f'Created online database snapshot: {create_snapshot(DB_PATH)}', flush=True)
