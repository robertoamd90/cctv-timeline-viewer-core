#!/usr/bin/env python3
"""Benchmark index reconciliation without invoking ffprobe or real archives."""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import tempfile
import time
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPOSITORY_ROOT))

from ctv_server import db
from ctv_server.indexer import index_camera
from ctv_server.scanner import scan_directory


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--recordings", type=int, default=20_000)
    parser.add_argument("--present", type=int, default=10_000)
    parser.add_argument("--iterations", type=int, default=3)
    args = parser.parse_args()
    if not 0 <= args.present <= args.recordings or args.iterations < 1:
        parser.error("present must be within recordings and iterations must be positive")

    with tempfile.TemporaryDirectory(prefix="ctv-index-benchmark-") as directory:
        root = Path(directory)
        source = root / "source"
        source.mkdir()
        for index in range(args.recordings):
            (source / f"clip_{index:08d}.mp4").touch()
        metadata = scan_directory(str(source))

        db.DB_PATH = str(root / "benchmark.db")
        db.init_db()
        conn = db.get_db()
        camera_id = conn.execute(
            "INSERT INTO cameras (name, source_path, timezone, indexing_mode) "
            "VALUES ('Benchmark', ?, 'UTC', 'full')",
            (str(source),),
        ).lastrowid
        conn.executemany(
            """
            INSERT INTO recordings (
                camera_id, path, filename, start_ts, end_ts, duration,
                size, mtime, availability, last_seen
            ) VALUES (?, ?, ?, ?, ?, 30, ?, ?, 'available', ?)
            """,
            (
                (
                    camera_id,
                    item["path"],
                    item["filename"],
                    1_700_000_000 + index * 60,
                    1_700_000_030 + index * 60,
                    item["size"],
                    item["mtime"],
                    1_700_000_000,
                )
                for index, item in enumerate(metadata)
            ),
        )
        conn.commit()
        conn.close()

        for item in metadata[args.present:]:
            Path(item["path"]).unlink()

        scan_samples = []
        for _ in range(args.iterations):
            started = time.perf_counter()
            scan_directory(str(source))
            scan_samples.append((time.perf_counter() - started) * 1000)

        samples = []
        result = None
        for _ in range(args.iterations):
            conn = db.get_db()
            conn.execute(
                "UPDATE recordings SET availability = 'available' WHERE camera_id = ?",
                (camera_id,),
            )
            conn.commit()
            conn.close()
            started = time.perf_counter()
            result = index_camera(camera_id, str(source))
            samples.append((time.perf_counter() - started) * 1000)

        print(json.dumps({
            "recordings": args.recordings,
            "present": args.present,
            "iterations": args.iterations,
            "median_ms": round(statistics.median(samples), 3),
            "min_ms": round(min(samples), 3),
            "max_ms": round(max(samples), 3),
            "directory_scan_median_ms": round(statistics.median(scan_samples), 3),
            "last_result": result,
        }, indent=2, sort_keys=True))
        db.close_db()


if __name__ == "__main__":
    main()
