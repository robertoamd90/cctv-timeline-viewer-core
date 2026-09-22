import json
import tempfile
import unittest
from datetime import datetime, timezone
from unittest.mock import patch

from ctv_server import db
from ctv_server.operations import index_generation
from ctv_server.recording_events import enrich_partition, extract_events, parse_mapping


class RecordingEventsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old = db.DB_PATH
        db.DB_PATH = self.tmp.name + '/test.db'
        db.init_db()
        self.ts = datetime(2026, 1, 1, 12, tzinfo=timezone.utc).timestamp()
        with db.write_db() as conn:
            self.camera = conn.execute("INSERT INTO cameras(name,source_path,timezone,time_offset_seconds,ha_event_entities) VALUES('Test','/test','UTC',60,'binary_sensor.person=person')").lastrowid
            for n in range(2):
                conn.execute("INSERT INTO recordings(camera_id,path,filename,start_ts,end_ts,partition_key) VALUES(?,?,?,?,?,'2026-01-01')", (self.camera, f'/test/{n}.mp4',f'{n}.mp4', self.ts+n*60, self.ts+(n+1)*60))

    def tearDown(self):
        db.DB_PATH = self.old
        self.tmp.cleanup()

    def history(self):
        def stamp(ts):
            return datetime.fromtimestamp(ts, timezone.utc).isoformat()
        return [[{'entity_id':'binary_sensor.person','state':'off','last_changed':stamp(self.ts)},
                 {'state':'on','last_changed':stamp(self.ts+70)},
                 {'state':'on','last_changed':stamp(self.ts+71)},
                 {'state':'off','last_changed':stamp(self.ts+80)},
                 {'state':'on','last_changed':stamp(self.ts+120)}]]

    def rows(self):
        conn = db.get_db()
        try:
            return conn.execute('SELECT * FROM recordings ORDER BY start_ts').fetchall()
        finally:
            conn.close()

    def test_batched_offset_association_and_cache(self):
        with patch('ctv_server.recording_events.fetch_history', return_value=self.history()) as fetch:
            enrich_partition(self.camera,'2026-01-01',index_generation())
            enrich_partition(self.camera,'2026-01-01',index_generation())
        self.assertEqual(fetch.call_count, 1)
        rows = self.rows()
        self.assertEqual(json.loads(rows[0]['ha_events']),[{'type':'person','timestamp':self.ts+70}])
        self.assertEqual(json.loads(rows[1]['ha_events']),[{'type':'person','timestamp':self.ts+120}])

    def test_empty_response_is_not_proof_of_no_events(self):
        with patch('ctv_server.recording_events.fetch_history', return_value=[]):
            enrich_partition(self.camera,'2026-01-01',index_generation())
        self.assertEqual(self.rows()[0]['ha_events_status'],'unknown')

    def test_failure_preserves_saved_events(self):
        with patch('ctv_server.recording_events.fetch_history', return_value=self.history()):
            enrich_partition(self.camera,'2026-01-01',index_generation())
        with db.write_db() as conn:
            conn.execute("UPDATE recordings SET ha_events_status='error',ha_events_checked=1")
        with patch('ctv_server.recording_events.fetch_history', side_effect=TimeoutError):
            enrich_partition(self.camera,'2026-01-01',index_generation())
        self.assertEqual(self.rows()[0]['ha_events_status'],'error')
        self.assertEqual(len(json.loads(self.rows()[0]['ha_events'])),1)

    def test_mapping_change_refetches(self):
        with patch('ctv_server.recording_events.fetch_history', return_value=self.history()) as fetch:
            enrich_partition(self.camera,'2026-01-01',index_generation())
            with db.write_db() as conn:
                conn.execute("UPDATE cameras SET ha_event_entities='binary_sensor.person=motion'")
            enrich_partition(self.camera,'2026-01-01',index_generation())
        self.assertEqual(fetch.call_count,2)
        self.assertEqual(json.loads(self.rows()[0]['ha_events'])[0]['type'],'motion')

    def test_generation_prevents_stale_write(self):
        with patch('ctv_server.recording_events.fetch_history') as fetch:
            enrich_partition(self.camera,'2026-01-01',index_generation()-1)
        fetch.assert_not_called()

    def test_carry_in_state_and_attributes_do_not_create_events(self):
        result = extract_events(self.history(), {'binary_sensor.person':'person'},self.ts+75,self.ts+130)
        self.assertEqual(result,[{'type':'person','timestamp':self.ts+120}])

    def test_mapping_validation(self):
        for invalid in ['sensor.a=person','binary_sensor.a=unknown','binary_sensor.a=person\nbinary_sensor.a=motion']:
            with self.assertRaises(ValueError):
                parse_mapping(invalid)

    def test_successful_scan_enriches_without_changing_ready_status(self):
        from ctv_server.partition_service import run_partition_scan
        with db.write_db() as conn:
            conn.execute("UPDATE cameras SET source_path=?", (self.tmp.name,))
            conn.execute("INSERT INTO partitions(camera_id,partition_key,path,status) VALUES(?,'2026-01-01',?,'queued')", (self.camera,self.tmp.name))
        with patch('ctv_server.partition_service.index_camera', return_value={'total':2}), \
             patch('ctv_server.partition_service.threading.Thread'), \
             patch('ctv_server.recording_events.fetch_history', side_effect=TimeoutError) as fetch:
            result = run_partition_scan(self.camera,'2026-01-01',self.tmp.name)
        self.assertEqual(result['status'],'done')
        fetch.assert_called_once()
        self.assertEqual(self.rows()[0]['ha_events_status'],'error')

    def test_dst_day_uses_local_midnights(self):
        from zoneinfo import ZoneInfo
        start = datetime(2026,3,29,tzinfo=ZoneInfo('Europe/Rome')).timestamp()
        with db.write_db() as conn:
            conn.execute("UPDATE cameras SET timezone='Europe/Rome',time_offset_seconds=0")
            conn.execute("UPDATE recordings SET partition_key='2026-03-29',start_ts=?,end_ts=?",(start+3600,start+3660))
        with patch('ctv_server.recording_events.fetch_history',return_value=[]) as fetch:
            enrich_partition(self.camera,'2026-03-29',index_generation())
        args = fetch.call_args.args
        self.assertEqual(args[2]-args[1],23*3600)

    def test_camera_mapping_api_roundtrip(self):
        from ctv_server.api.cameras import create_camera, update_camera
        from ctv_server.models import CameraCreate, CameraUpdate
        camera = create_camera(CameraCreate(name='New',source_path=self.tmp.name,timezone='UTC',ha_event_entities='binary_sensor.car=vehicle'))
        self.assertEqual(camera.ha_event_entities,'binary_sensor.car=vehicle')
        updated = update_camera(camera.id,CameraUpdate(name='New',source_path=self.tmp.name,timezone='UTC',ha_event_entities=''))
        self.assertEqual(updated.ha_event_entities,'')
