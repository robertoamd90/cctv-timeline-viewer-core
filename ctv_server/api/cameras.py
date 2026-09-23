import os
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException, Request
from ctv_server.auth import CurrentUser, current_user, require_admin
from ctv_server.config import path_within_source_roots
from ctv_server.db import get_db, write_db
from ctv_server.models import CameraCreate, CameraResponse, CameraUpdate
from ctv_server.partitioner import validate_pattern

router = APIRouter(prefix="/api/cameras", tags=["cameras"])


def _delete_camera_index_data(conn, camera_id: int) -> list[str]:
    """Delete derived rows one at a time, avoiding disk-backed statement journals."""
    recordings = conn.execute(
        "SELECT id, thumbnail_path FROM recordings WHERE camera_id = ?", (camera_id,)
    ).fetchall()
    conn.executemany(
        "DELETE FROM recordings WHERE id = ?",
        ((row["id"],) for row in recordings),
    )
    partitions = conn.execute(
        "SELECT partition_key FROM partitions WHERE camera_id = ?", (camera_id,)
    ).fetchall()
    conn.executemany(
        "DELETE FROM partitions WHERE camera_id = ? AND partition_key = ?",
        ((camera_id, row["partition_key"]) for row in partitions),
    )
    conn.execute("DELETE FROM camera_recording_counts WHERE camera_id = ?", (camera_id,))
    return [row["thumbnail_path"] for row in recordings if row["thumbnail_path"]]


def _local_tz() -> str:
    """Restituisce il timezone IANA del sistema (es. 'Europe/Rome').
    Su macOS/Linux legge /etc/localtime. Fallback a 'UTC'."""
    import os
    for p in ("/etc/localtime", "/var/db/timezone/zoneinfo"):
        try:
            link = os.readlink(p)
            # /etc/localtime -> /usr/share/zoneinfo/Europe/Rome
            # oppure /var/db/timezone/zoneinfo/Europe/Rome
            for sep in ("zoneinfo/", "zoneinfo"):
                parts = link.rsplit(sep, 1)
                if len(parts) == 2 and parts[1]:
                    return parts[1].lstrip("/")
        except Exception:
            continue
    try:
        with open("/etc/timezone") as f:
            tz = f.read().strip()
            if tz: return tz
    except Exception:
        pass
    return "UTC"


def _validate_source(source_path: str, timezone: str) -> tuple[str, str]:
    path = os.path.abspath(source_path)
    try:
        ZoneInfo(timezone)
    except ZoneInfoNotFoundError:
        raise HTTPException(status_code=422, detail=f"Timezone non valida: {timezone}")
    if not path_within_source_roots(path):
        raise HTTPException(status_code=403, detail="La sorgente e fuori dalle directory consentite")
    if not os.path.isdir(path):
        raise HTTPException(status_code=422, detail="La sorgente non esiste o non e montata")
    try:
        # os.access non e affidabile sui mount smbfs di macOS: prova una vera enumerazione.
        with os.scandir(path) as entries:
            next(entries, None)
    except PermissionError:
        raise HTTPException(
            status_code=422,
            detail="La sorgente esiste ma il processo CTV non ha il permesso di leggerla",
        )
    except OSError as exc:
        raise HTTPException(status_code=422, detail=f"Impossibile leggere la sorgente: {exc}")
    return path, timezone


@router.get("")
def list_cameras(request: Request) -> list[dict]:
    user = current_user(request)
    conn = get_db()
    rows = conn.execute("""
        SELECT c.*,
            COALESCE(counts.recordings_available, 0) AS recordings_available,
            COALESCE(counts.recordings_missing, 0) AS recordings_missing
        FROM cameras c
        LEFT JOIN camera_recording_counts counts ON counts.camera_id = c.id
        ORDER BY c.name
    """).fetchall()
    conn.close()
    if user.is_admin:
        return [CameraResponse(**dict(row)).model_dump() for row in rows]
    return [
        {
            "id": row["id"],
            "name": row["name"],
            "timezone": row["timezone"],
            "event_overlay_position": row["event_overlay_position"],
            "source_status": row["source_status"],
            "recordings_available": row["recordings_available"] or 0,
            "recordings_missing": row["recordings_missing"] or 0,
        }
        for row in rows
    ]


@router.post("", status_code=201)
def create_camera(body: CameraCreate, _: CurrentUser = Depends(require_admin)) -> CameraResponse:
    source_path = os.path.abspath(body.source_path)
    tz = body.timezone.strip() if body.timezone else _local_tz()
    source_path, tz = _validate_source(source_path, tz)
    try:
        pattern = validate_pattern(body.directory_pattern)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    with write_db() as conn:
        cur = conn.execute(
            "INSERT INTO cameras (name, source_path, timezone, time_offset_seconds, indexing_mode, "
            "directory_pattern, ha_event_entities, event_overlay_position, source_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'online')",
            (body.name.strip(), source_path, tz, body.time_offset_seconds, body.indexing_mode, pattern, body.ha_event_entities, body.event_overlay_position),
        )
        camera = conn.execute("SELECT * FROM cameras WHERE id = ?", (cur.lastrowid,)).fetchone()
    return CameraResponse(**dict(camera))


@router.put("/{camera_id}")
def update_camera(
    camera_id: int, body: CameraUpdate, _: CurrentUser = Depends(require_admin)
) -> CameraResponse:
    source_path, tz = _validate_source(body.source_path, body.timezone.strip())
    try:
        pattern = validate_pattern(body.directory_pattern)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    thumbnails = []
    with write_db() as conn:
        previous = conn.execute("SELECT * FROM cameras WHERE id = ?", (camera_id,)).fetchone()
        if not previous:
            raise HTTPException(status_code=404, detail="Camera not found")
        cache_changed = any((
            previous["source_path"] != source_path,
            previous["timezone"] != tz,
            previous["indexing_mode"] != body.indexing_mode,
            previous["directory_pattern"] != pattern,
        ))
        if cache_changed:
            thumbnails = _delete_camera_index_data(conn, camera_id)
        cur = conn.execute(
            "UPDATE cameras SET name = ?, source_path = ?, timezone = ?, time_offset_seconds = ?, "
            "indexing_mode = ?, directory_pattern = ?, ha_event_entities = ?, event_overlay_position = ?, "
            "source_status = ?, source_error = ? WHERE id = ?",
            (body.name.strip(), source_path, tz, body.time_offset_seconds,
             body.indexing_mode, pattern, body.ha_event_entities, body.event_overlay_position,
             "unknown" if cache_changed else previous["source_status"],
             None if cache_changed else previous["source_error"], camera_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Camera not found")
        if (previous["ha_event_entities"] != body.ha_event_entities or
                previous["time_offset_seconds"] != body.time_offset_seconds):
            # A new association must enrich even a recently indexed day.
            conn.execute("UPDATE partitions SET last_scanned = NULL WHERE camera_id = ?", (camera_id,))
        camera = conn.execute("SELECT * FROM cameras WHERE id = ?", (camera_id,)).fetchone()
    for thumbnail in thumbnails:
        try:
            os.unlink(thumbnail)
        except OSError:
            pass
    return CameraResponse(**dict(camera))


@router.get("/{camera_id}")
def get_camera(camera_id: int, _: CurrentUser = Depends(require_admin)) -> CameraResponse:
    conn = get_db()
    row = conn.execute("SELECT * FROM cameras WHERE id = ?", (camera_id,)).fetchone()
    conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Camera not found")
    return CameraResponse(**dict(row))


@router.delete("/{camera_id}")
def delete_camera(camera_id: int, _: CurrentUser = Depends(require_admin)):
    from ctv_server.scan_service import is_scanning

    if is_scanning(camera_id):
        raise HTTPException(status_code=409, detail="Attendi la fine della scansione prima di eliminare la telecamera")
    thumbnails = []
    with write_db() as conn:
        camera = conn.execute("SELECT id FROM cameras WHERE id = ?", (camera_id,)).fetchone()
        if camera:
            thumbnails = _delete_camera_index_data(conn, camera_id)
        cur = conn.execute("DELETE FROM cameras WHERE id = ?", (camera_id,))
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="Camera not found")
    for thumbnail in thumbnails:
        try:
            os.unlink(thumbnail)
        except OSError:
            pass
    return {"deleted": camera_id}
