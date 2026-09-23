import os
import tempfile
import threading
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch, Mock

from ctv_server import db
from ctv_server.autoscan import run_due_autoscans, recover_interrupted_scans
from ctv_server.indexer import index_camera
from ctv_server.index_queue import partition_slot
from ctv_server.scanner import scan_directory
from ctv_server.models import CameraCreate, CameraUpdate
from ctv_server.api.cameras import create_camera, update_camera


class AutoscanTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.old_db = db.DB_PATH
        db.DB_PATH = str(self.root/'db.sqlite')
        db.init_db()
        self.camera = create_camera(CameraCreate(name='Test', source_path=str(self.root), timezone='UTC'))
        self.now = datetime(2026, 9, 23, 12, tzinfo=timezone.utc).timestamp()
        self.day = self.root/'2026/09/23'
        self.day.mkdir(parents=True)
        self.probe = patch('ctv_server.indexer.get_ffprobe_data', return_value={'format': {'duration': '30'}, 'streams': []}).start()
        self.thumbs = patch('ctv_server.partition_service._generate_thumbnails').start()

    def tearDown(self):
        patch.stopall()
        db.DB_PATH = self.old_db
        self.tmp.cleanup()

    def enable(self, **values):
        self.camera = update_camera(self.camera.id, CameraUpdate(name='Test', source_path=str(self.root), timezone='UTC', autoscan_enabled=True, **values))

    def tick(self, now=None):
        with patch('ctv_server.autoscan.time.time', return_value=self.now if now is None else now):
            run_due_autoscans()

    def rows(self):
        with db.get_db() as conn:
            rows = conn.execute('SELECT * FROM recordings').fetchall()
        conn.close()
        return rows

    def media(self, name='clip.mp4'):
        path = self.day/name
        path.write_bytes(b'video')
        os.utime(path, (self.now-300,self.now-300))
        return path

    def light(self):
        return index_camera(self.camera.id,str(self.day),partition_key='2026-09-23',incremental=True)

    def test_default_off_validation_and_saved_settings(self):
        self.tick()
        self.assertFalse(self.camera.autoscan_enabled)
        self.assertEqual(self.camera.autoscan_interval_minutes,60)
        self.assertEqual(self.probe.call_count,0)
        self.enable(autoscan_interval_minutes=10)
        self.assertTrue(self.camera.autoscan_enabled)
        self.assertEqual(self.camera.autoscan_interval_minutes,10)
        for invalid in [0,-1,10081,1.5]:
            with self.assertRaises(ValueError):
                CameraCreate(name='x',source_path='/x',autoscan_interval_minutes=invalid)

    def test_only_today_and_persistent_interval(self):
        self.media()
        yesterday=self.root/'2026/09/22'
        yesterday.mkdir()
        (yesterday/'old.mp4').write_bytes(b'old')
        self.enable()
        self.tick()
        self.assertEqual(len(self.rows()),1)
        self.assertEqual(self.rows()[0]['partition_key'],'2026-09-23')
        self.media('new.mp4')
        db.init_db()  # A restart must retain the last attempt and settings.
        self.tick(self.now+3599)
        self.assertEqual(len(self.rows()),1)
        self.tick(self.now+3600)
        self.assertEqual(len(self.rows()),2)

    def test_timezone_rollover_without_previous_day_scan(self):
        self.enable()
        with db.write_db() as conn:
            conn.execute("UPDATE cameras SET timezone='Pacific/Kiritimati', autoscan_last_attempt=?, autoscan_last_day='2026-09-23'", (self.now-1,))
        tomorrow=self.root/'2026/09/24'
        tomorrow.mkdir()
        (tomorrow/'tomorrow.mp4').write_bytes(b'video')
        self.tick()
        self.assertEqual(self.rows()[0]['partition_key'],'2026-09-24')

    def test_settled_files_skip_metadata_and_db_writes(self):
        media=self.media()
        self.light()
        self.light()  # Confirm unchanged, older than quiet period, valid duration.
        row=self.rows()[0]
        self.assertEqual(row['autoscan_settled'],1)
        with patch('ctv_server.indexer.scan_directory', wraps=scan_directory) as listing:
            self.light()
        self.assertEqual(listing.call_args.kwargs['skip_paths'],{str(media)})
        self.assertEqual(dict(self.rows()[0]),dict(row))
        self.assertEqual(self.probe.call_count,1)

    def test_scanner_does_not_stat_or_classify_known_files(self):
        entry=Mock(path='/day/known.mp4')
        entries=Mock()
        entries.__enter__=Mock(return_value=iter([entry]))
        entries.__exit__=Mock(return_value=False)
        with patch('ctv_server.scanner.os.path.isdir',return_value=True), patch('ctv_server.scanner.os.scandir',return_value=entries):
            self.assertEqual(scan_directory('/day',{'/day/known.mp4'}),[])
        entry.stat.assert_not_called()
        entry.is_dir.assert_not_called()

    def test_growing_file_and_failed_probe_are_retried(self):
        media=self.media()
        self.probe.return_value={}
        self.light()
        self.light()
        self.assertEqual(self.probe.call_count,2)
        self.assertEqual(self.rows()[0]['autoscan_settled'],0)
        self.probe.return_value={'format':{'duration':'30'},'streams':[]}
        media.write_bytes(b'longer video')
        self.light()
        self.assertEqual(self.rows()[0]['duration'],30)
        self.assertEqual(self.rows()[0]['autoscan_settled'],0)

    def test_deleted_and_replaced_stable_files_reconcile_on_full_scan(self):
        media=self.media()
        self.light(); self.light()
        media.write_bytes(b'replaced content')
        self.light()
        self.assertEqual(self.probe.call_count,1)
        index_camera(self.camera.id,str(self.day),partition_key='2026-09-23',purge_missing=True)
        self.assertEqual(self.probe.call_count,2)
        media.unlink()
        self.light()
        self.assertEqual(len(self.rows()),1)
        index_camera(self.camera.id,str(self.day),partition_key='2026-09-23',purge_missing=True)
        self.assertEqual(len(self.rows()),0)

    def test_offline_attempt_respects_interval_and_retains_records(self):
        self.media(); self.enable(); self.tick()
        with db.write_db() as conn:
            conn.execute("UPDATE cameras SET source_path=?", (str(self.root/'offline'),))
        self.tick(self.now+3600)
        self.assertEqual(len(self.rows()),1)
        with patch('ctv_server.autoscan.run_partition_scan') as scan:
            self.tick(self.now+3601)
            scan.assert_not_called()

    def test_missing_day_preserves_records_and_full_scan_remains_due(self):
        self.media(); self.enable(); self.tick()
        self.day.rename(self.day.with_name('moved'))
        self.tick(self.now+3600)
        self.assertEqual(len(self.rows()),1)
        with db.get_db() as conn:
            row=conn.execute('SELECT * FROM partitions').fetchone()
        conn.close()
        self.assertIsNone(row['last_scanned'])
        self.assertIsNone(row['last_requested'])

    def test_foreground_reservation_and_running_slot_defer_background(self):
        self.enable()
        with partition_slot():
            self.tick()
        with db.write_db() as conn:
            self.assertIsNone(conn.execute('SELECT autoscan_last_attempt FROM cameras').fetchone()[0])
            conn.execute("UPDATE partitions SET status='queued'")
        with patch('ctv_server.autoscan.run_partition_scan') as scan:
            self.tick()
            scan.assert_not_called()

    def test_full_mode_never_autoscanned(self):
        self.enable(indexing_mode='full')
        with patch('ctv_server.autoscan.run_partition_scan') as scan:
            self.tick()
            scan.assert_not_called()

    def test_events_enriched_by_scheduled_indexing(self):
        self.media(); self.enable()
        with patch('ctv_server.recording_events.enrich_partition') as enrich:
            self.tick()
        self.assertEqual(enrich.call_args.args[:2],(self.camera.id,'2026-09-23'))

    def test_restart_recovers_interrupted_reservations(self):
        self.media(); self.enable()
        with db.write_db() as conn:
            conn.execute("INSERT INTO partitions(camera_id,partition_key,path,status) VALUES(?,?,?,'scanning')", (self.camera.id,'2026-09-23',str(self.day)))
        recover_interrupted_scans()
        self.tick()
        self.assertEqual(len(self.rows()),1)

    def test_disable_and_stop_prevent_new_work(self):
        self.enable()
        stop=threading.Event(); stop.set()
        with patch('ctv_server.autoscan.run_partition_scan') as scan:
            run_due_autoscans(stop)
            scan.assert_not_called()
        update_camera(self.camera.id, CameraUpdate(name='Test',source_path=str(self.root),timezone='UTC',autoscan_enabled=False))
        with patch('ctv_server.autoscan.run_partition_scan') as scan:
            self.tick()
            scan.assert_not_called()

    def test_opening_day_during_background_reserves_full_reconciliation(self):
        from ctv_server.partition_service import prepare_partitions, _lock_for
        self.enable()
        with db.write_db() as conn:
            conn.execute("INSERT INTO partitions(camera_id,partition_key,path,status) VALUES(?,?,?,'background')", (self.camera.id,'2026-09-23',str(self.day)))
        with _lock_for(self.camera.id,'2026-09-23'):
            jobs=prepare_partitions([self.camera.id],self.now,self.now+60)
            duplicate=prepare_partitions([self.camera.id],self.now,self.now+60)
        self.assertEqual(len(jobs),1)
        self.assertEqual(duplicate,[])
