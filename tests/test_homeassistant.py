import asyncio
import os
import random
import sqlite3
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import BackgroundTasks, HTTPException
from starlette.requests import Request

from ctv_server import auth
from ctv_server import db
from ctv_server.api.cameras import list_cameras, update_camera
from ctv_server.api.events import _sanitize
from ctv_server.api.recordings import _public_recording, list_recordings
from ctv_server.api.search import search
from ctv_server.api.system import list_source_directories, rebuild_index
from ctv_server.api.timeline import get_timeline, get_timeline_bounds, prepare_timeline
from ctv_server.auth import CurrentUser, require_admin, user_from_request
from ctv_server.config import path_within_source_roots, source_roots
from ctv_server.models import CameraUpdate
from ctv_server.operations import (
    begin_index_job, end_index_job, index_generation, maintenance_window,
)


def make_request(headers=None, user=None):
    raw_headers = [
        (key.lower().encode("latin-1"), value.encode("latin-1"))
        for key, value in (headers or {}).items()
    ]
    request = Request({
        "type": "http",
        "method": "GET",
        "path": "/",
        "headers": raw_headers,
        "client": ("172.30.32.2", 1234),
        "server": ("ctv", 8000),
        "scheme": "http",
    })
    if user is not None:
        request.state.ctv_user = user
    return request


class AuthorizationTests(unittest.TestCase):
    def tearDown(self):
        auth.reset_role_cache()

    def test_admin_dependency_rejects_viewer(self):
        viewer = CurrentUser("viewer", "viewer", "Viewer", False, True)
        with self.assertRaises(HTTPException) as raised:
            require_admin(make_request(user=viewer))
        self.assertEqual(raised.exception.status_code, 403)

    def test_admin_dependency_fails_closed_when_roles_are_unavailable(self):
        unresolved = CurrentUser("admin", "admin", "Admin", False, False)
        with self.assertRaises(HTTPException) as raised:
            require_admin(make_request(user=unresolved))
        self.assertEqual(raised.exception.status_code, 503)

    def test_ingress_identity_uses_home_assistant_role(self):
        request = make_request({
            "X-Remote-User-Id": "abc",
            "X-Remote-User-Name": "roberto",
            "X-Remote-User-Display-Name": "Roberto",
        })
        with patch.dict(os.environ, {"CTV_DEPLOYMENT": "homeassistant"}, clear=False), \
             patch("ctv_server.auth.resolve_admin", new=AsyncMock(return_value=(True, True))):
            user = asyncio.run(user_from_request(request))
        self.assertTrue(user.is_admin)
        self.assertEqual(user.id, "abc")

    def test_admin_only_ingress_trusts_supervisor_authorization(self):
        request = make_request({
            "X-Remote-User-Id": "abc",
            "X-Remote-User-Name": "roberto",
        })
        with patch.dict(os.environ, {
            "CTV_DEPLOYMENT": "homeassistant",
            "CTV_HA_ADMIN_ONLY": "1",
        }, clear=False), patch(
            "ctv_server.auth.resolve_admin", new=AsyncMock()
        ) as resolve:
            user = asyncio.run(user_from_request(request))
        self.assertTrue(user.is_admin)
        self.assertTrue(user.role_resolved)
        resolve.assert_not_awaited()

    def test_missing_ingress_identity_is_rejected(self):
        with patch.dict(os.environ, {"CTV_DEPLOYMENT": "homeassistant"}, clear=False):
            with self.assertRaises(HTTPException) as raised:
                asyncio.run(user_from_request(make_request()))
        self.assertEqual(raised.exception.status_code, 401)


class SourceBrowserTests(unittest.TestCase):
    def test_browser_is_confined_to_configured_root(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as outside:
            os.mkdir(os.path.join(root, "Garage"))
            admin = CurrentUser("admin", "admin", "Admin", True, True)
            with patch.dict(os.environ, {"CTV_SOURCE_ROOTS": root}, clear=False):
                self.assertEqual(source_roots(), (os.path.realpath(root),))
                self.assertTrue(path_within_source_roots(os.path.join(root, "Garage")))
                self.assertFalse(path_within_source_roots(outside))
                result = list_source_directories(None, root, admin)
                self.assertEqual([entry["name"] for entry in result["entries"]], ["Garage"])
                with self.assertRaises(HTTPException) as raised:
                    list_source_directories(None, outside, admin)
            self.assertEqual(raised.exception.status_code, 403)

    def test_symlink_cannot_escape_source_root(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as outside:
            os.symlink(outside, os.path.join(root, "escape"))
            with patch.dict(os.environ, {"CTV_SOURCE_ROOTS": root}, clear=False):
                self.assertFalse(path_within_source_roots(os.path.join(root, "escape")))


class PublicApiTests(unittest.TestCase):
    def test_timeline_and_search_preserve_offset_boundary_semantics(self):
        with tempfile.TemporaryDirectory() as tmp:
            original = db.DB_PATH
            db.DB_PATH = os.path.join(tmp, "ctv.db")
            try:
                db.init_db()
                start = 1_656_764_092.4331014
                offset = -2_249.819440960884
                public_start = start + offset
                # Floating-point subtraction does not reconstruct this start
                # exactly.  The optimized candidate lookup must still retain
                # the original public `start + offset <= to` behavior.
                self.assertGreater(start, public_start - offset)
                conn = db.get_db()
                camera_id = conn.execute(
                    "INSERT INTO cameras "
                    "(name, source_path, timezone, time_offset_seconds, indexing_mode) "
                    "VALUES ('Boundary', ?, 'UTC', ?, 'full')",
                    (tmp, offset),
                ).lastrowid
                conn.execute(
                    "INSERT INTO recordings "
                    "(camera_id, path, filename, start_ts, end_ts, duration) "
                    "VALUES (?, 'boundary.mp4', 'boundary.mp4', ?, ?, 30)",
                    (camera_id, start, start + 30),
                )
                conn.commit()
                conn.close()

                timeline = get_timeline(
                    public_start - 1, public_start, str(camera_id),
                )
                results = search(
                    q="boundary", camera_id=camera_id, from_ts=None,
                    to_ts=public_start, min_duration=None, limit=10,
                )
            finally:
                db.DB_PATH = original
            self.assertEqual(
                [segment["filename"] for segment in timeline["cameras"][0]["segments"]],
                ["boundary.mp4"],
            )
            self.assertEqual([result["filename"] for result in results], ["boundary.mp4"])

    def test_timeline_interval_index_matches_fallback_for_random_ranges(self):
        generator = random.Random(20260808)
        with tempfile.TemporaryDirectory() as tmp:
            original = db.DB_PATH
            db.DB_PATH = os.path.join(tmp, "ctv.db")
            try:
                db.init_db()
                conn = db.get_db()
                camera_id = conn.execute(
                    "INSERT INTO cameras (name, source_path, timezone, time_offset_seconds, indexing_mode) "
                    "VALUES ('Stress', ?, 'UTC', -3.75, 'full')", (tmp,),
                ).lastrowid
                rows = []
                for index in range(300):
                    start = generator.uniform(-20_000, 20_000)
                    end = None if index % 17 == 0 else start + generator.uniform(0.01, 1_000)
                    if index % 29 == 0:
                        end = start - 5
                    rows.append((
                        camera_id, f"{index}.mp4", f"{index}.mp4", start, end,
                        "missing" if index % 11 == 0 else "available",
                    ))
                conn.executemany(
                    "INSERT INTO recordings "
                    "(camera_id, path, filename, start_ts, end_ts, availability) "
                    "VALUES (?, ?, ?, ?, ?, ?)", rows,
                )
                conn.commit()
                conn.close()

                ranges = []
                for _ in range(60):
                    start = generator.uniform(-21_000, 20_500)
                    ranges.append((start, start + generator.uniform(0.001, 2_000)))
                indexed = [
                    get_timeline(start, end, str(camera_id)) for start, end in ranges
                ]
                indexed_search = [
                    search(
                        q="1", camera_id=None, from_ts=start, to_ts=end,
                        min_duration=None, limit=25,
                    )
                    for start, end in ranges[:10]
                ]

                conn = db.get_db()
                conn.execute(
                    "UPDATE schema_state SET value = 'unavailable' "
                    "WHERE key = 'recording_ranges_ready'"
                )
                conn.commit()
                conn.close()
                fallback = [
                    get_timeline(start, end, str(camera_id)) for start, end in ranges
                ]
                fallback_search = [
                    search(
                        q="1", camera_id=None, from_ts=start, to_ts=end,
                        min_duration=None, limit=25,
                    )
                    for start, end in ranges[:10]
                ]
            finally:
                db.DB_PATH = original
            self.assertEqual(indexed, fallback)
            self.assertEqual(indexed_search, fallback_search)

    def test_timeline_interval_index_matches_exact_fallback_and_tracks_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            original = db.DB_PATH
            db.DB_PATH = os.path.join(tmp, "ctv.db")
            try:
                db.init_db()
                conn = db.get_db()
                camera_id = conn.execute(
                    "INSERT INTO cameras (name, source_path, timezone, time_offset_seconds, indexing_mode) "
                    "VALUES ('Garage', ?, 'UTC', -4.5, 'full')",
                    (tmp,),
                ).lastrowid
                conn.executemany(
                    "INSERT INTO recordings "
                    "(camera_id, path, filename, start_ts, end_ts, availability) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (
                        (camera_id, "long.mp4", "long.mp4", 100.125, 250.875, "available"),
                        (camera_id, "point.mp4", "point.mp4", 260.25, None, "available"),
                        (camera_id, "missing.mp4", "missing.mp4", 140, 240, "missing"),
                    ),
                )
                conn.commit()
                counts = conn.execute(
                    "SELECT recordings_available, recordings_missing "
                    "FROM camera_recording_counts WHERE camera_id = ?", (camera_id,)
                ).fetchone()
                conn.close()
                self.assertEqual(tuple(counts), (2, 1))

                indexed = get_timeline(95, 270, str(camera_id))
                self.assertEqual(
                    [segment["filename"] for segment in indexed["cameras"][0]["segments"]],
                    ["long.mp4", "point.mp4"],
                )
                self.assertEqual(get_timeline_bounds(), {"first": 95.625, "last": 255.75})

                conn = db.get_db()
                conn.execute(
                    "UPDATE schema_state SET value = 'unavailable' "
                    "WHERE key = 'recording_ranges_ready'"
                )
                conn.commit()
                conn.close()
                self.assertEqual(get_timeline(95, 270, str(camera_id)), indexed)

                conn = db.get_db()
                conn.execute(
                    "UPDATE schema_state SET value = '1' WHERE key = 'recording_ranges_ready'"
                )
                conn.execute(
                    "UPDATE recordings SET start_ts = 500, end_ts = 510 WHERE filename = 'long.mp4'"
                )
                conn.execute("DELETE FROM recordings WHERE filename = 'point.mp4'")
                conn.commit()
                range_count = conn.execute("SELECT COUNT(*) FROM recording_ranges").fetchone()[0]
                recording_count = conn.execute("SELECT COUNT(*) FROM recordings").fetchone()[0]
                counts = conn.execute(
                    "SELECT recordings_available, recordings_missing "
                    "FROM camera_recording_counts WHERE camera_id = ?", (camera_id,)
                ).fetchone()
                conn.close()
                self.assertEqual(range_count, recording_count)
                self.assertEqual(tuple(counts), (1, 1))
                self.assertEqual(get_timeline(95, 270, str(camera_id))["cameras"][0]["segments"], [])
                moved = get_timeline(495, 506, str(camera_id))["cameras"][0]["segments"]
                self.assertEqual([segment["filename"] for segment in moved], ["long.mp4"])
            finally:
                db.DB_PATH = original

    def test_rebuild_index_preserves_cameras_and_deletes_derived_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            original = db.DB_PATH
            db.DB_PATH = os.path.join(tmp, "ctv.db")
            thumbnail_dir = os.path.join(tmp, "thumbnails")
            os.mkdir(thumbnail_dir)
            thumbnail = os.path.join(thumbnail_dir, "1.jpg")
            open(thumbnail, "wb").close()
            try:
                db.init_db()
                conn = db.get_db()
                camera_id = conn.execute(
                    "INSERT INTO cameras (name, source_path, timezone, time_offset_seconds) "
                    "VALUES ('Garage', ?, 'UTC', -5)", (tmp,),
                ).lastrowid
                conn.execute(
                    "INSERT INTO recordings (id, camera_id, path, filename, start_ts, thumbnail_path) "
                    "VALUES (1, ?, 'clip.mp4', 'clip.mp4', 100, ?)", (camera_id, thumbnail),
                )
                conn.execute(
                    "INSERT INTO partitions (camera_id, partition_key, path) VALUES (?, '2026-07-21', ?)",
                    (camera_id, tmp),
                )
                conn.commit()
                conn.close()
                admin = CurrentUser("admin", "admin", "Admin", True, True)
                with patch("ctv_server.api.system.THUMBNAIL_DIR", thumbnail_dir):
                    result = rebuild_index(admin)
                conn = db.get_db()
                camera = conn.execute(
                    "SELECT name, time_offset_seconds FROM cameras WHERE id = ?", (camera_id,)
                ).fetchone()
                recordings = conn.execute("SELECT COUNT(*) FROM recordings").fetchone()[0]
                partitions = conn.execute("SELECT COUNT(*) FROM partitions").fetchone()[0]
                conn.close()
            finally:
                db.DB_PATH = original
            self.assertEqual((camera["name"], camera["time_offset_seconds"]), ("Garage", -5))
            self.assertEqual((recordings, partitions), (0, 0))
            self.assertEqual(result["recordings_deleted"], 1)
            self.assertFalse(os.path.exists(thumbnail))
            self.assertEqual(result["range_index"], "ready")

    def test_rebuild_index_bypasses_a_broken_range_trigger(self):
        with tempfile.TemporaryDirectory() as tmp:
            original = db.DB_PATH
            db.DB_PATH = os.path.join(tmp, "ctv.db")
            try:
                db.init_db()
                conn = db.get_db()
                camera_id = conn.execute(
                    "INSERT INTO cameras (name, source_path, indexing_mode) "
                    "VALUES ('Garage', ?, 'full')", (tmp,),
                ).lastrowid
                conn.execute(
                    "INSERT INTO recordings (camera_id, path, filename, start_ts) "
                    "VALUES (?, 'clip.mp4', 'clip.mp4', 100)", (camera_id,),
                )
                conn.execute("DROP TRIGGER recordings_range_delete")
                conn.execute("""
                    CREATE TRIGGER recordings_range_delete
                    BEFORE DELETE ON recordings
                    BEGIN
                        SELECT RAISE(ABORT, 'derived range index is broken');
                    END
                """)
                conn.commit()
                conn.close()

                admin = CurrentUser("admin", "admin", "Admin", True, True)
                result = rebuild_index(admin)

                conn = db.get_db()
                conn.execute(
                    "INSERT INTO recordings (camera_id, path, filename, start_ts) "
                    "VALUES (?, 'new.mp4', 'new.mp4', 200)", (camera_id,),
                )
                conn.commit()
                recording_count = conn.execute("SELECT COUNT(*) FROM recordings").fetchone()[0]
                range_count = conn.execute("SELECT COUNT(*) FROM recording_ranges").fetchone()[0]
                conn.close()
            finally:
                db.DB_PATH = original
            self.assertEqual(result["recordings_deleted"], 1)
            self.assertEqual(result["range_index"], "ready")
            self.assertEqual((recording_count, range_count), (1, 1))

    def test_startup_disables_range_hooks_when_write_probe_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            original = db.DB_PATH
            db.DB_PATH = os.path.join(tmp, "ctv.db")
            try:
                with patch(
                    "ctv_server.db._probe_recording_range_index",
                    side_effect=sqlite3.OperationalError("unable to open database file"),
                ):
                    db.init_db()
                conn = db.get_db()
                state = conn.execute(
                    "SELECT value FROM schema_state WHERE key = 'recording_ranges_ready'"
                ).fetchone()[0]
                triggers = conn.execute(
                    "SELECT COUNT(*) FROM sqlite_master "
                    "WHERE type = 'trigger' AND name LIKE 'recordings_range_%'"
                ).fetchone()[0]
                camera_id = conn.execute(
                    "INSERT INTO cameras (name, source_path) VALUES ('Garage', ?)", (tmp,),
                ).lastrowid
                conn.execute(
                    "INSERT INTO recordings (camera_id, path, filename, start_ts) "
                    "VALUES (?, 'clip.mp4', 'clip.mp4', 100)", (camera_id,),
                )
                conn.commit()
                conn.close()
            finally:
                db.DB_PATH = original
            self.assertEqual(state, "unavailable")
            self.assertEqual(triggers, 0)

    def test_rebuild_index_rejects_active_scan(self):
        self.assertTrue(begin_index_job())
        try:
            admin = CurrentUser("admin", "admin", "Admin", True, True)
            with self.assertRaises(HTTPException) as raised:
                rebuild_index(admin)
        finally:
            end_index_job()
        self.assertEqual(raised.exception.status_code, 409)

    def test_rebuild_invalidates_queued_index_jobs(self):
        queued_generation = index_generation()
        with maintenance_window():
            pass
        self.assertFalse(begin_index_job(queued_generation))

    def test_viewer_camera_response_hides_source_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            original = db.DB_PATH
            db.DB_PATH = os.path.join(tmp, "ctv.db")
            try:
                db.init_db()
                conn = db.get_db()
                conn.execute(
                    "INSERT INTO cameras (name, source_path, timezone) VALUES (?, ?, ?)",
                    ("Garage", "/media/private/Garage", "UTC"),
                )
                conn.commit()
                conn.close()
                viewer = CurrentUser("viewer", "viewer", "Viewer", False, True)
                cameras = list_cameras(make_request(user=viewer))
            finally:
                db.DB_PATH = original
            self.assertEqual(cameras[0]["name"], "Garage")
            self.assertNotIn("source_path", cameras[0])

    def test_recording_response_does_not_expose_filesystem_data(self):
        result = _public_recording({
            "id": 1,
            "camera_id": 2,
            "filename": "clip.mp4",
            "start_ts": 1.0,
            "end_ts": 2.0,
            "duration": 1.0,
            "path": "/media/private/clip.mp4",
            "hash": "secret",
            "metadata": "{}",
        })
        self.assertEqual(result["filename"], "clip.mp4")
        self.assertNotIn("path", result)
        self.assertNotIn("hash", result)
        self.assertNotIn("metadata", result)

    def test_viewer_event_hides_paths_and_detailed_errors(self):
        result = _sanitize({
            "camera_id": 1,
            "path": "/media/private/Garage",
            "error": "Permission denied: /media/private/Garage",
        })
        self.assertNotIn("path", result)
        self.assertEqual(result["error"], "Source unavailable")

    def test_timeline_prepare_is_limited_to_48_hours(self):
        with self.assertRaises(HTTPException) as raised:
            prepare_timeline(BackgroundTasks(), 0, 172801, None)
        self.assertEqual(raised.exception.status_code, 422)

    def test_updating_camera_offset_keeps_stored_timestamps_and_adjusts_api(self):
        with tempfile.TemporaryDirectory() as tmp:
            original = db.DB_PATH
            db.DB_PATH = os.path.join(tmp, "ctv.db")
            try:
                db.init_db()
                conn = db.get_db()
                camera_id = conn.execute(
                    "INSERT INTO cameras (name, source_path, timezone, indexing_mode) "
                    "VALUES (?, ?, ?, 'full')",
                    ("Garage", tmp, "UTC"),
                ).lastrowid
                conn.execute(
                    "INSERT INTO recordings (camera_id, path, filename, start_ts, end_ts) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (camera_id, os.path.join(tmp, "clip.mp4"), "clip.mp4", 100, 110),
                )
                conn.commit()
                conn.close()
                admin = CurrentUser("admin", "admin", "Admin", True, True)
                result = update_camera(camera_id, CameraUpdate(
                    name="Garage", source_path=tmp, timezone="UTC", time_offset_seconds=-5,
                    indexing_mode="full", directory_pattern="{YYYY}/{MM}/{DD}",
                ), admin)
                conn = db.get_db()
                recording = conn.execute(
                    "SELECT start_ts, end_ts FROM recordings WHERE camera_id = ?", (camera_id,)
                ).fetchone()
                conn.close()
                public = list_recordings(
                    camera_id=camera_id, from_ts=None, to_ts=None, limit=100, offset=0
                )
                timeline = get_timeline(90, 120, str(camera_id))
            finally:
                db.DB_PATH = original
            self.assertEqual(result.time_offset_seconds, -5)
            self.assertEqual((recording["start_ts"], recording["end_ts"]), (100, 110))
            self.assertEqual((public[0]["start_ts"], public[0]["end_ts"]), (95, 105))
            segment = timeline["cameras"][0]["segments"][0]
            self.assertEqual((segment["start_ts"], segment["end_ts"]), (95, 105))


if __name__ == "__main__":
    unittest.main()
