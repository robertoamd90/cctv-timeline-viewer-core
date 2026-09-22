import math
import json
from typing import Optional
from fastapi import APIRouter, BackgroundTasks, HTTPException, Query
from ctv_server.db import get_db
from ctv_server.partition_service import prepare_partitions, run_partition_scan
from ctv_server.partitioner import dates_for_range, partition_key

router = APIRouter(prefix="/api/timeline", tags=["timeline"])


def _camera_ids(value: Optional[str]) -> list[int]:
    return [int(item) for item in (value or "").split(",") if item.strip().isdigit()]


@router.post("/prepare", status_code=202)
def prepare_timeline(
    background: BackgroundTasks,
    from_ts: float = Query(..., alias="from"),
    to_ts: float = Query(..., alias="to"),
    camera_ids: Optional[str] = Query(None, alias="cameras"),
):
    if not math.isfinite(from_ts) or not math.isfinite(to_ts) or to_ts <= from_ts:
        raise HTTPException(status_code=422, detail="Invalid timeline range")
    if to_ts - from_ts > 172800:
        raise HTTPException(status_code=422, detail="Timeline preparation is limited to 48 hours")
    ids = _camera_ids(camera_ids)
    if not ids:
        conn = get_db()
        ids = [row["id"] for row in conn.execute("SELECT id FROM cameras").fetchall()]
        conn.close()
    jobs = prepare_partitions(ids, from_ts, to_ts)
    for job in jobs:
        background.add_task(
            run_partition_scan, job["camera_id"], job["key"], job["path"], job["generation"]
        )
    return {"status": "queued", "partitions": len(jobs)}


def _timeline_bounds(conn) -> tuple:
    cameras = conn.execute(
        "SELECT id, indexing_mode, time_offset_seconds FROM cameras"
    ).fetchall()
    first = None
    last = None
    for camera in cameras:
        partition_clause = (
            "" if camera["indexing_mode"] == "full" else " AND partition_key IS NOT NULL"
        )
        earliest = conn.execute(f"""
            SELECT start_ts FROM recordings
            WHERE camera_id = ? AND availability = 'available' {partition_clause}
            ORDER BY start_ts LIMIT 1
        """, (camera["id"],)).fetchone()
        latest = conn.execute(f"""
            SELECT COALESCE(end_ts, start_ts) AS end_ts FROM recordings
            WHERE camera_id = ? AND availability = 'available' {partition_clause}
            ORDER BY COALESCE(end_ts, start_ts) DESC LIMIT 1
        """, (camera["id"],)).fetchone()
        offset = camera["time_offset_seconds"] or 0
        if earliest:
            candidate = earliest["start_ts"] + offset
            first = candidate if first is None else min(first, candidate)
        if latest:
            candidate = latest["end_ts"] + offset
            last = candidate if last is None else max(last, candidate)
    return first, last


@router.get("/bounds")
def get_timeline_bounds():
    conn = get_db()
    first, last = _timeline_bounds(conn)
    conn.close()
    return {"first": first, "last": last}


@router.get("")
def get_timeline(
    from_ts: Optional[float] = Query(None, alias="from"),
    to_ts: Optional[float] = Query(None, alias="to"),
    camera_ids: Optional[str] = Query(None, alias="cameras"),
):
    """Restituisce i segmenti della timeline raggruppati per telecamera."""
    conn = get_db()

    # Se nessun range specificato, usa i limiti dei dati
    if from_ts is None or to_ts is None:
        first, last = _timeline_bounds(conn)
        if from_ts is None:
            from_ts = first or 0
        if to_ts is None:
            to_ts = last or (from_ts + 86400)

    selected_ids = _camera_ids(camera_ids)
    camera_query = "SELECT * FROM cameras"
    camera_params: list = []
    if selected_ids:
        camera_query += " WHERE id IN (" + ",".join("?" for _ in selected_ids) + ")"
        camera_params.extend(selected_ids)
    camera_query += " ORDER BY name"
    selected_cameras = conn.execute(camera_query, camera_params).fetchall()

    cameras_map: dict = {}
    partition_keys_by_camera: dict[int, list[str]] = {}
    for camera in selected_cameras:
        state = "ready" if camera["indexing_mode"] == "full" else "unknown"
        progress_done = progress_total = 0
        if camera["indexing_mode"] == "partitioned":
            offset = camera["time_offset_seconds"] or 0
            keys = [
                partition_key(day)
                for day in dates_for_range(from_ts - offset, to_ts - offset, camera["timezone"])
            ]
            partition_keys_by_camera[camera["id"]] = keys
            placeholders = ",".join("?" for _ in keys)
            partitions = conn.execute(
                f"SELECT status, progress_done, progress_total FROM partitions "
                f"WHERE camera_id = ? AND partition_key IN ({placeholders})",
                (camera["id"], *keys),
            ).fetchall() if keys else []
            statuses = [row["status"] for row in partitions]
            progress_done = sum(row["progress_done"] for row in partitions)
            progress_total = sum(row["progress_total"] for row in partitions)
            if any(status in {"queued", "scanning"} for status in statuses):
                state = "scanning"
            elif any(status == "error" for status in statuses):
                state = "error"
            elif statuses and all(status == "missing" for status in statuses):
                state = "missing"
            elif statuses and all(status in {"ready", "missing"} for status in statuses):
                state = "ready"
        cameras_map[camera["id"]] = {
            "camera_id": camera["id"],
            "camera_name": camera["name"],
            "partition_status": state,
            "progress_done": progress_done,
            "progress_total": progress_total,
            "segments": [],
        }

    columns = (
        "r.id, r.camera_id, r.filename, r.start_ts, r.end_ts, "
        "r.duration, r.media_kind, r.thumbnail_path, r.ha_events, r.ha_events_status"
    )

    # Camera offsets differ, so query each camera in its physical time range.
    # Partitioned cameras are constrained to the exact daily partitions for
    # the requested window; the composite B-tree then keeps this lookup small.
    for camera in selected_cameras:
        camera_id = camera["id"]
        offset = camera["time_offset_seconds"] or 0
        physical_from = from_ts - offset
        physical_to = to_ts - offset
        conditions = [
            "r.camera_id = ?",
            "r.availability = 'available'",
            "COALESCE(r.end_ts, r.start_ts) >= ?",
            "r.start_ts <= ?",
            "COALESCE(r.end_ts, r.start_ts) + ? >= ?",
            "r.start_ts + ? <= ?",
        ]
        params: list = [
            camera_id,
            math.nextafter(physical_from, -math.inf),
            math.nextafter(physical_to, math.inf),
            offset,
            from_ts,
            offset,
            to_ts,
        ]
        if camera["indexing_mode"] == "partitioned":
            keys = partition_keys_by_camera.get(camera_id, [])
            if not keys:
                rows = []
            else:
                conditions.append(
                    "r.partition_key IN (" + ",".join("?" for _ in keys) + ")"
                )
                params.extend(keys)
                rows = conn.execute(f"""
                    SELECT {columns}
                    FROM recordings r
                    WHERE {' AND '.join(conditions)}
                    ORDER BY r.start_ts
                """, params).fetchall()
        else:
            rows = conn.execute(f"""
                SELECT {columns}
                FROM recordings r
                WHERE {' AND '.join(conditions)}
                ORDER BY r.start_ts
            """, params).fetchall()

        segments = cameras_map[camera_id]["segments"]
        for row in rows:
            segments.append({
                "id": row["id"],
                "events": json.loads(row["ha_events"]) if camera["ha_event_entities"] else [],
                "events_status": row["ha_events_status"] if camera["ha_event_entities"] else "disabled",
                "filename": row["filename"],
                "start_ts": row["start_ts"] + offset,
                "end_ts": row["end_ts"] + offset if row["end_ts"] is not None else None,
                "duration": row["duration"],
                "media_kind": row["media_kind"],
                "has_thumbnail": row["thumbnail_path"] is not None,
            })

    conn.close()
    return {
        "from": from_ts,
        "to": to_ts,
        "cameras": list(cameras_map.values()),
    }
