"""Run the CLI against sparse historical archives and direct camera roots."""
from datetime import date, datetime, timedelta, timezone
import json
import os
from pathlib import Path
import shutil
import sqlite3
import struct
import subprocess
import tempfile
import time
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[2]
PHP = os.environ.get('PHP_BIN') or shutil.which('php')
assert PHP, 'Set PHP_BIN to a PHP CLI with pdo_sqlite'
checks = 0


def check(condition, message):
    global checks
    checks += 1
    assert condition, message


def box(kind, payload):
    return struct.pack('>I', len(payload) + 8) + kind.encode() + payload


MP4 = box('ftyp', b'isom' + b'\0' * 12) + box('moov', box('mvhd',
    b'\0' * 12 + struct.pack('>II', 1000, 1250) + b'\0' * 80))


def recording(folder, day):
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / ('Camera_' + day.strftime('%Y%m%d') + '120000.mp4')
    path.write_bytes(MP4)
    os.utime(path, (time.time() - 86400, time.time() - 86400))
    return path


def environment(folder, roots):
    return dict(os.environ, CTV_PHP_SOURCE_ROOTS=';'.join(map(str, roots)),
                CTV_PHP_DATA_DIR=str(folder / 'data'), CTV_PHP_TIMEZONE='UTC')


def cli(env, *options, success=True):
    result = subprocess.run([PHP, str(ROOT / 'ctv_php/bin/index.php'), *options],
                            env=env, capture_output=True, text=True, timeout=20)
    check((result.returncode == 0) == success, result.stdout + result.stderr)
    return result


def rows(env, table='recordings'):
    with sqlite3.connect(Path(env['CTV_PHP_DATA_DIR']) / 'ctv.sqlite') as db:
        db.row_factory = sqlite3.Row
        return [dict(row) for row in db.execute('SELECT * FROM ' + table)]


def add_camera(env, source, name, pattern='{YYYY}/{MM}/{DD}', zone='UTC', mode='partitioned'):
    with sqlite3.connect(Path(env['CTV_PHP_DATA_DIR']) / 'ctv.sqlite') as db:
        return db.execute('INSERT INTO cameras(name,source_path,timezone,indexing_mode,directory_pattern) VALUES(?,?,?,?,?)',
                          (name, str(source), zone, mode, pattern)).lastrowid


with tempfile.TemporaryDirectory(prefix='ctv_indexer_') as temporary:
    tmp = Path(temporary)
    today = datetime.now(timezone.utc).date()
    historical = date(2000, 1, 1)
    yesterday = today - timedelta(days=1)
    days = [historical, yesterday, today]
    archive = tmp / 'archive'
    source = archive / 'Wand1'
    files = {day: recording(source / day.strftime('%Y/%m/%d'), day) for day in days}
    other = archive / 'FishEye1'
    recording(other / historical.strftime('%Y/%m/%d'), historical)
    # Invalid dates and unrelated directory names must never become partitions.
    recording(source / '2026/02/31', date(2026, 2, 28))
    recording(source / 'notes/2026/10/07', today)
    outside = tmp / 'outside'
    recording(outside, date(1999, 1, 1))
    (source / '1999/01').mkdir(parents=True)
    (source / '1999/01/01').symlink_to(outside, target_is_directory=True)

    parent_env = environment(tmp / 'parent', [archive])
    cli(parent_env, '--discover')
    cameras = rows(parent_env, 'cameras')
    check({c['name'] for c in cameras} == {'Wand1', 'FishEye1'}, 'Parent-root discovery keeps camera names')
    indexed = rows(parent_env)
    check(len(indexed) == 4, 'Default indexing includes sparse historical and current dates')
    check({r['path'] for r in indexed} == {str(path) for path in files.values()} | {str(other / historical.strftime('%Y/%m/%d') / 'Camera_20000101120000.mp4')},
          'Only valid, contained recording partitions are indexed')
    check({r['partition_key'] for r in indexed} == {day.isoformat() for day in days}, 'History retains date partition keys')
    before = {r['path']: r['id'] for r in indexed}
    result = cli(parent_env, '--all')
    check({r['path']: r['id'] for r in rows(parent_env)} == before, 'Repeating a whole-archive scan preserves ids without duplicates')
    check('"new":0' in result.stdout and '"skipped":1' in result.stdout, 'Unchanged history is skipped on repeat scans')

    # Removing an entire known partition must reconcile its previously indexed rows.
    shutil.rmtree(files[historical].parent)
    cli(parent_env)
    check(next(r for r in rows(parent_env) if r['path'] == str(files[historical]))['availability'] == 'missing',
          'Whole-archive indexing reconciles a removed day directory')
    files[historical] = recording(source / historical.strftime('%Y/%m/%d'), historical)

    direct_env = environment(tmp / 'direct', [source, other])
    cli(direct_env, '--discover', '--all')
    check({c['name'] for c in rows(direct_env, 'cameras')} == {'Wand1', 'FishEye1'},
          'Direct camera roots are discovered as cameras, not year folders')
    check({c['source_path'] for c in rows(direct_env, 'cameras')} == {str(source), str(other)},
          'Direct-root camera sources point above the year directory')
    check(len(rows(direct_env)) == 4, 'Direct-root discovery indexes the complete history')
    cli(direct_env, '--discover')
    check(len(rows(direct_env, 'cameras')) == 2, 'Discovery is idempotent')

    empty = tmp / 'EmptyCamera'
    (empty / '2026/10').mkdir(parents=True)
    empty_env = environment(tmp / 'empty', [empty])
    cli(empty_env, '--discover')
    check([c['name'] for c in rows(empty_env, 'cameras')] == ['EmptyCamera'],
          'A camera root is recognized before its first day or recording exists')

    recent_env = environment(tmp / 'recent', [archive])
    cli(recent_env, '--discover', '--days=2')
    check({r['partition_key'] for r in rows(recent_env)} == {yesterday.isoformat(), today.isoformat()},
          'Incremental cron scans index only the requested recent dates')
    cli(recent_env)
    check(len(rows(recent_env)) == 4, 'Default scan backfills history into an index already containing today')

    selected_env = environment(tmp / 'selected', [archive])
    cli(selected_env, '--discover', '--date=2000-01-01')
    selected_camera = next(c for c in rows(selected_env, 'cameras') if c['name'] == 'Wand1')
    cli(selected_env, '--all', '--camera=' + str(selected_camera['id']))
    check(sum(r['camera_id'] == selected_camera['id'] for r in rows(selected_env)) == 3,
          'Camera selection works for whole-archive scans')
    check(len(rows(selected_env)) == 4, 'Other cameras retain their existing index')
    conflict = cli(selected_env, '--all', '--days=2', success=False)
    check('not both' in conflict.stderr, 'Conflicting full and incremental modes fail clearly')

    # Reproduce the deployed configuration: old discovery added a year as a camera.
    legacy_env = environment(tmp / 'legacy', [source])
    cli(legacy_env, '--days=1')
    legacy_id = add_camera(legacy_env, source / str(today.year), str(today.year))
    with sqlite3.connect(Path(legacy_env['CTV_PHP_DATA_DIR']) / 'ctv.sqlite') as db:
        db.execute("INSERT INTO partitions(camera_id,partition_key,status) VALUES(?,?,'missing')", (legacy_id, today.isoformat()))
    result = cli(legacy_env, '--discover', '--all')
    check(len(rows(legacy_env)) == 3, 'Corrected discovery recovers recordings alongside legacy year-camera entries')
    check('No MP4 files found' in result.stdout and 'above the year directory' in result.stdout,
          'Misconfigured legacy cameras get an actionable message even after earlier empty scans')

    custom = tmp / 'custom'
    custom.mkdir()
    custom_env = environment(tmp / 'patterns', [custom])
    cli(custom_env)
    camera_id = add_camera(custom_env, custom, 'Custom', 'daily/{YYYY}-{MM}-{DD}/clips')
    recording(custom / 'daily/2024-02-29/clips', date(2024, 2, 29))
    recording(custom / 'daily/2024-02-30/clips', date(2024, 2, 29))
    cli(custom_env, '--all', '--camera=' + str(camera_id))
    check([r['partition_key'] for r in rows(custom_env)] == ['2024-02-29'],
          'Literal directories, combined date tokens and leap-year validation work')

    short = custom / 'ShortYear'
    short.mkdir()
    short_id = add_camera(custom_env, short, 'ShortYear', '{YY}/{MM}/{DD}')
    recording(short / '26/10/06', date(2026, 10, 6))
    cli(custom_env, '--all', '--camera=' + str(short_id))
    check(next(r for r in rows(custom_env) if r['camera_id'] == short_id)['partition_key'] == '2026-10-06',
          'Two-digit year directories map to the 2000s')

    repeated = custom / 'RepeatedYear'
    repeated.mkdir()
    repeated_id = add_camera(custom_env, repeated, 'RepeatedYear', '{YYYY}/{YY}/{MM}/{DD}')
    recording(repeated / '2026/26/10/06', date(2026, 10, 6))
    recording(repeated / '2026/25/10/06', date(2026, 10, 6))
    cli(custom_env, '--all', '--camera=' + str(repeated_id))
    check(sum(r['camera_id'] == repeated_id for r in rows(custom_env)) == 1,
          'Conflicting year tokens cannot map two directories to the same date')

    pacific = custom / 'Pacific'
    pacific.mkdir()
    pacific_id = add_camera(custom_env, pacific, 'Pacific', zone='Pacific/Kiritimati')
    local_today = datetime.now(ZoneInfo('Pacific/Kiritimati')).date()
    recording(pacific / local_today.strftime('%Y/%m/%d'), local_today)
    recording(pacific / (local_today - timedelta(days=1)).strftime('%Y/%m/%d'), local_today - timedelta(days=1))
    cli(custom_env, '--camera=' + str(pacific_id), '--days=1')
    check([r['partition_key'] for r in rows(custom_env) if r['camera_id'] == pacific_id] == [local_today.isoformat()],
          'Incremental scans calculate today in the camera timezone')

    full = custom / 'Full'
    full.mkdir()
    full_id = add_camera(custom_env, full, 'Full', mode='full')
    recording(full, historical)
    cli(custom_env, '--camera=' + str(full_id), '--days=1')
    check(next(r for r in rows(custom_env) if r['camera_id'] == full_id)['partition_key'] is None,
          'Full-directory cameras still scan all footage when cron selects recent days')

    # A known unsafe day fails, but the next historical partition still succeeds.
    with sqlite3.connect(Path(parent_env['CTV_PHP_DATA_DIR']) / 'ctv.sqlite') as db:
        wand_id = next(c['id'] for c in cameras if c['name'] == 'Wand1')
        db.execute("INSERT INTO partitions(camera_id,partition_key,status) VALUES(?,?,'ready')", (wand_id, '1999-01-01'))
    result = cli(parent_env, '--all', success=False)
    check('1999-01-01' in result.stderr and '2000-01-01' in result.stdout,
          'A failed day does not stop later days in the same camera')
    check(next(r for r in rows(parent_env) if r['path'] == str(files[historical]))['availability'] == 'available',
          'The healthy historical partition is restored despite a failed earlier day')

print(f'PHP CLI indexing integration tests passed ({checks} checks)')
