#!/usr/bin/env python3
"""Repeatable synthetic performance benchmark for the hot read paths.

The benchmark creates an isolated SQLite database, so it never reads or writes
the configured CCTV archive.  It intentionally reports timings instead of
asserting thresholds: hardware and filesystems differ too much for this to be a
unit test.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPOSITORY_ROOT))

from ctv_server import db
from ctv_server.api.cameras import list_cameras
from ctv_server.api.search import search
from ctv_server.api.timeline import get_timeline, get_timeline_bounds
from ctv_server.auth import CurrentUser


def timed(callable_, iterations: int) -> dict[str, float]:
    samples = []
    result = None
    for _ in range(iterations):
        started = time.perf_counter()
        result = callable_()
        samples.append((time.perf_counter() - started) * 1000)
    ordered = sorted(samples)
    p95_index = min(len(ordered) - 1, int(len(ordered) * 0.95))
    return {
        "median_ms": round(statistics.median(samples), 3),
        "p95_ms": round(ordered[p95_index], 3),
        "min_ms": round(min(samples), 3),
        "result_size": len(json.dumps(result, separators=(",", ":"))) if result is not None else 0,
    }


def populate(total_recordings: int, camera_count: int) -> tuple[float, float, list[int]]:
    conn = db.get_db()
    conn.execute("PRAGMA synchronous=OFF")
    camera_ids = []
    for camera_index in range(camera_count):
        cursor = conn.execute(
            """
            INSERT INTO cameras (
                name, source_path, timezone, time_offset_seconds, indexing_mode,
                source_status
            ) VALUES (?, ?, 'UTC', ?, 'full', 'online')
            """,
            (f"Camera {camera_index:02d}", f"/synthetic/camera-{camera_index}", camera_index * 0.25),
        )
        camera_ids.append(cursor.lastrowid)

    per_camera = total_recordings // camera_count
    base = 1_700_000_000.0
    batch = []
    for camera_id in camera_ids:
        for recording_index in range(per_camera):
            start = base + recording_index * 60
            batch.append((
                camera_id,
                f"/synthetic/camera-{camera_id}/{recording_index:08d}.mp4",
                f"{recording_index:08d}.mp4",
                start,
                start + 30,
                30.0,
                1_000_000,
                start,
                start,
            ))
            if len(batch) >= 10_000:
                conn.executemany(
                    """
                    INSERT INTO recordings (
                        camera_id, path, filename, start_ts, end_ts, duration,
                        size, mtime, last_seen
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    batch,
                )
                batch.clear()
    if batch:
        conn.executemany(
            """
            INSERT INTO recordings (
                camera_id, path, filename, start_ts, end_ts, duration,
                size, mtime, last_seen
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            batch,
        )
    conn.commit()
    conn.execute("PRAGMA optimize")
    conn.close()

    midpoint = base + (per_camera // 2) * 60
    return midpoint, midpoint + 3_600, camera_ids


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--recordings", type=int, default=400_000)
    parser.add_argument("--cameras", type=int, default=8)
    parser.add_argument("--iterations", type=int, default=9)
    args = parser.parse_args()
    if args.recordings < args.cameras or args.cameras < 1 or args.iterations < 1:
        parser.error("recordings, cameras and iterations must be positive")

    with tempfile.TemporaryDirectory(prefix="ctv-benchmark-") as directory:
        db.DB_PATH = str(Path(directory) / "benchmark.db")
        db.init_db()
        from_ts, to_ts, camera_ids = populate(args.recordings, args.cameras)
        selected = ",".join(str(camera_id) for camera_id in camera_ids)
        request = SimpleNamespace(state=SimpleNamespace(
            ctv_user=CurrentUser("benchmark", "benchmark", "Benchmark", True, True),
        ))

        # Warm filesystem and SQLite page caches before collecting samples.
        get_timeline(from_ts, to_ts, selected)
        get_timeline_bounds()

        report = {
            "recordings": args.recordings // args.cameras * args.cameras,
            "cameras": args.cameras,
            "timeline_1h_all_cameras": timed(
                lambda: get_timeline(from_ts, to_ts, selected), args.iterations,
            ),
            "timeline_1h_one_camera": timed(
                lambda: get_timeline(from_ts, to_ts, str(camera_ids[0])), args.iterations,
            ),
            "timeline_bounds": timed(get_timeline_bounds, args.iterations),
            "camera_list_with_counts": timed(
                lambda: list_cameras(request), args.iterations,
            ),
            "search_filename_in_window": timed(
                lambda: search(
                    q=f"{args.recordings // args.cameras // 2:05d}",
                    camera_id=None,
                    from_ts=from_ts - 43_200,
                    to_ts=to_ts + 43_200,
                    min_duration=None,
                    limit=50,
                ),
                args.iterations,
            ),
        }

        connection_samples = []
        for _ in range(max(100, args.iterations * 20)):
            started = time.perf_counter()
            conn = db.get_db()
            conn.execute("SELECT 1").fetchone()
            conn.close()
            connection_samples.append((time.perf_counter() - started) * 1000)
        report["sqlite_connect_select_close"] = {
            "median_ms": round(statistics.median(connection_samples), 3),
            "p95_ms": round(sorted(connection_samples)[int(len(connection_samples) * 0.95)], 3),
        }
        print(json.dumps(report, indent=2, sort_keys=True))
        db.close_db()


if __name__ == "__main__":
    main()
