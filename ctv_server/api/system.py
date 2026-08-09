import os
import logging
import sqlite3
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from ctv_server.auth import CurrentUser, current_user, require_admin
from ctv_server.config import deployment_mode, path_within_source_roots, source_roots
from ctv_server.db import (
    retire_recording_range_index,
    sqlite_error_details,
    write_db,
)
from ctv_server.models import StreamProfilesUpdate
from ctv_server.operations import IndexBusyError, maintenance_window
from ctv_server.streaming import get_stream_profiles, invalidate_stream_profiles
from ctv_server.thumbnailer import THUMBNAIL_DIR

router = APIRouter(prefix="/api", tags=["system"])
log = logging.getLogger("ctv.system")


@router.get("/stream-profiles")
def stream_profiles():
    return get_stream_profiles()


@router.put("/admin/stream-profiles")
def update_stream_profiles(
    profiles: StreamProfilesUpdate,
    _: CurrentUser = Depends(require_admin),
):
    with write_db() as conn:
        for name, profile in (
            ("balanced", profiles.balanced),
            ("fast", profiles.fast),
        ):
            conn.execute(
                """
                UPDATE stream_profiles
                SET scale_percent = ?, fps = ?, bitrate_kbps = ?
                WHERE name = ?
                """,
                (profile.scale_percent, profile.fps, profile.bitrate_kbps, name),
            )
    invalidate_stream_profiles()
    return get_stream_profiles()


@router.post("/admin/rebuild-index")
def rebuild_index(_: CurrentUser = Depends(require_admin)):
    try:
        # Enter maintenance first so no new watcher/UI scan can replace the
        # one we are waiting for. This makes rebuild a reliable recovery path.
        with maintenance_window(wait_for_jobs=True):
            # Remove hooks left by early v0.1.27 betas before deleting rows.
            with write_db() as conn:
                recordings = conn.execute("SELECT COUNT(*) FROM recordings").fetchone()[0]
                partitions = conn.execute("SELECT COUNT(*) FROM partitions").fetchone()[0]
                thumbnail_paths = {
                    row[0] for row in conn.execute(
                        "SELECT thumbnail_path FROM recordings WHERE thumbnail_path IS NOT NULL"
                    ).fetchall()
                }
                retire_recording_range_index(conn)

            with write_db() as conn:
                recording_ids = conn.execute("SELECT id FROM recordings").fetchall()
                conn.executemany(
                    "DELETE FROM recordings WHERE id = ?",
                    ((row["id"],) for row in recording_ids),
                )
                partition_ids = conn.execute(
                    "SELECT camera_id, partition_key FROM partitions"
                ).fetchall()
                conn.executemany(
                    "DELETE FROM partitions WHERE camera_id = ? AND partition_key = ?",
                    ((row["camera_id"], row["partition_key"]) for row in partition_ids),
                )
                conn.execute("DELETE FROM camera_recording_counts")
                conn.execute(
                    "UPDATE cameras SET source_status = 'unknown', source_error = NULL, "
                    "last_scan_started = NULL, last_scan_completed = NULL"
                )

            thumbnail_paths.update(str(path) for path in Path(THUMBNAIL_DIR).glob("*.jpg"))
            thumbnails = 0
            for thumbnail in thumbnail_paths:
                try:
                    os.unlink(thumbnail)
                    thumbnails += 1
                except FileNotFoundError:
                    pass
                except OSError:
                    pass
    except IndexBusyError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except sqlite3.Error as exc:
        detail = sqlite_error_details(exc)
        log.exception("Database rebuild failed: %s", detail)
        raise HTTPException(
            status_code=503,
            detail=f"Database write failed during rebuild: {detail}",
        ) from exc

    return {
        "status": "rebuilt",
        "recordings_deleted": recordings,
        "partitions_deleted": partitions,
        "thumbnails_deleted": thumbnails,
        "timeline_index": {"strategy": "partition_btree", "status": "ready"},
    }


@router.get("/session")
def session(request: Request):
    user = current_user(request)
    return {
        "deployment": deployment_mode(),
        "authenticated": True,
        "user": {
            "id": user.id,
            "name": user.name,
            "display_name": user.display_name,
        },
        "is_admin": user.is_admin,
        "role_resolved": user.role_resolved,
        "source_roots": list(source_roots()) if user.is_admin else [],
        "timeline_index": {"strategy": "partition_btree", "status": "ready"},
    }


@router.get("/sources/directories")
def list_source_directories(
    request: Request,
    path: Optional[str] = Query(None),
    _: CurrentUser = Depends(require_admin),
):
    roots = source_roots()
    if not roots:
        raise HTTPException(status_code=404, detail="No source roots configured")
    selected = os.path.realpath(os.path.abspath(path or roots[0]))
    if not path_within_source_roots(selected):
        raise HTTPException(status_code=403, detail="Path is outside the configured source roots")
    if not os.path.isdir(selected):
        raise HTTPException(status_code=404, detail="Directory not found")

    entries = []
    try:
        with os.scandir(selected) as iterator:
            for entry in iterator:
                if entry.name.startswith("."):
                    continue
                try:
                    is_directory = entry.is_dir(follow_symlinks=True)
                except OSError:
                    continue
                if not is_directory:
                    continue
                candidate = os.path.realpath(entry.path)
                if path_within_source_roots(candidate):
                    entries.append({"name": entry.name, "path": candidate})
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail="Directory is not readable") from exc
    except OSError as exc:
        raise HTTPException(status_code=422, detail=f"Unable to read directory: {exc}") from exc

    entries.sort(key=lambda item: item["name"].casefold())
    root = None
    for candidate_root in roots:
        try:
            if os.path.commonpath((candidate_root, selected)) == candidate_root:
                root = candidate_root
                break
        except ValueError:
            continue
    if root is None:
        raise HTTPException(status_code=403, detail="Path is outside the configured source roots")
    parent = os.path.dirname(selected) if selected != root else None
    return {
        "root": root,
        "path": selected,
        "parent": parent,
        "entries": entries,
    }
