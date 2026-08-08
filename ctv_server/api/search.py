import math
from typing import Optional
from fastapi import APIRouter, Query
from ctv_server.db import (
    RANGE_BUCKET_SECONDS,
    RECORDING_TIME_DELTA_SQL,
    get_db,
    recording_time_delta,
)

router = APIRouter(prefix="/api/search", tags=["search"])


def _public_result(row) -> dict:
    offset = recording_time_delta(row)
    return {
        "id": row["id"],
        "camera_id": row["camera_id"],
        "camera_name": row["camera_name"],
        "filename": row["filename"],
        "start_ts": row["start_ts"] + offset,
        "end_ts": row["end_ts"] + offset if row["end_ts"] is not None else None,
        "duration": row["duration"],
    }


@router.get("")
def search(
    q: str = "",
    camera_id: Optional[int] = None,
    from_ts: Optional[float] = Query(None, alias="from"),
    to_ts: Optional[float] = Query(None, alias="to"),
    min_duration: Optional[float] = None,
    limit: int = 100,
):
    """Cerca registrazioni per nome file, camera, intervallo, durata."""
    conn = get_db()
    range_state = conn.execute(
        "SELECT value FROM schema_state WHERE key = 'recording_ranges_ready'"
    ).fetchone()
    finite_range = all(
        value is None or math.isfinite(value) for value in (from_ts, to_ts)
    )
    if (
        range_state
        and range_state["value"] == "1"
        and finite_range
        and (from_ts is not None or to_ts is not None)
    ):
        if limit == 0:
            conn.close()
            return []
        camera_query = "SELECT id, name, time_offset_seconds FROM cameras"
        camera_params = []
        if camera_id is not None:
            camera_query += " WHERE id = ?"
            camera_params.append(camera_id)
        cameras = conn.execute(camera_query, camera_params).fetchall()
        rows = []
        pattern = f"%{q}%"
        for camera in cameras:
            offset = camera["time_offset_seconds"] or 0
            conditions = [
                "ranges.camera_id_min <= ?",
                "ranges.camera_id_max >= ?",
                "r.camera_id = ?",
                "r.availability = 'available'",
            ]
            params = [camera["id"], camera["id"], camera["id"]]
            if from_ts is not None:
                physical_from = from_ts - offset
                conditions.extend((
                    "ranges.end_bucket >= ?",
                    "r.end_ts + ? >= ?",
                ))
                params.extend((
                    math.floor(physical_from / RANGE_BUCKET_SECONDS), offset, from_ts,
                ))
            if to_ts is not None:
                physical_to = to_ts - offset
                conditions.extend((
                    "ranges.start_bucket <= ?",
                    "r.start_ts + ? <= ?",
                ))
                params.extend((
                    math.ceil(physical_to / RANGE_BUCKET_SECONDS), offset, to_ts,
                ))
            if q:
                conditions.append("(r.filename LIKE ? OR ? LIKE ?)")
                params.extend((pattern, camera["name"], pattern))
            if min_duration is not None:
                conditions.append("r.duration >= ?")
                params.append(min_duration)
            per_camera_limit = limit if limit > 0 else -1
            rows.extend(conn.execute(f"""
                SELECT r.id, r.camera_id, r.filename, r.start_ts, r.end_ts, r.duration,
                       ? AS camera_name, ? AS time_offset_seconds
                FROM recording_ranges ranges
                JOIN recordings r ON r.id = ranges.recording_id
                WHERE {' AND '.join(conditions)}
                ORDER BY r.start_ts DESC
                LIMIT ?
            """, (camera["name"], offset, *params, per_camera_limit)).fetchall())
        conn.close()
        results = [_public_result(row) for row in rows]
        results.sort(key=lambda result: result["start_ts"], reverse=True)
        return results if limit < 0 else results[:limit]

    query = "SELECT r.*, c.name as camera_name, c.time_offset_seconds FROM recordings r JOIN cameras c ON r.camera_id = c.id WHERE r.availability = 'available'"
    params: list = []

    if q:
        query += " AND (r.filename LIKE ? OR c.name LIKE ?)"
        params.extend([f"%{q}%", f"%{q}%"])
    if camera_id is not None:
        query += " AND r.camera_id = ?"
        params.append(camera_id)
    if from_ts is not None:
        query += f" AND r.end_ts + {RECORDING_TIME_DELTA_SQL} >= ?"
        params.append(from_ts)
    if to_ts is not None:
        query += f" AND r.start_ts + {RECORDING_TIME_DELTA_SQL} <= ?"
        params.append(to_ts)
    if min_duration is not None:
        query += " AND r.duration >= ?"
        params.append(min_duration)

    query += f" ORDER BY r.start_ts + {RECORDING_TIME_DELTA_SQL} DESC LIMIT ?"
    params.append(limit)

    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [_public_result(row) for row in rows]
