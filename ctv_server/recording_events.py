"""Optional HA history enrichment, persisted on existing recording rows."""
import hashlib
import json
import logging
import re
import time
from datetime import datetime, timedelta
from urllib.parse import urlencode
from ctv_server.ha_client import get_json, HAError
from zoneinfo import ZoneInfo

from ctv_server.db import get_db, write_db
from ctv_server.operations import index_generation

log = logging.getLogger("ctv.recording_events")
TYPES = {"person", "vehicle", "animal", "motion", "doorbell"}


def parse_mapping(value):
    result = {}
    for line in value.splitlines():
        if not line.strip():
            continue
        entity, sep, kind = line.strip().partition("=")
        entity, kind = entity.strip(), kind.strip()
        if not sep or not re.fullmatch(r"binary_sensor\.[a-z0-9_]+", entity) or kind not in TYPES:
            raise ValueError("Expected binary_sensor.entity=person|vehicle|animal|motion|doorbell")
        if entity in result:
            raise ValueError("Duplicate HA entity")
        result[entity] = kind
    if len(result) > 16:
        raise ValueError("At most 16 HA entities per camera")
    return result


def fetch_history(mapping, start, end):
    query = urlencode({"filter_entity_id": ",".join(mapping),
                       "end_time": datetime.fromtimestamp(end, ZoneInfo("UTC")).isoformat(),
                       "no_attributes": "", "minimal_response": ""})
    stamp = datetime.fromtimestamp(start, ZoneInfo("UTC")).isoformat()
    return get_json(f'/history/period/{stamp}?{query}')


def extract_events(history, mapping, start, end):
    events = {}
    for states in history:
        if not states:
            continue
        entity = states[0].get("entity_id")
        if entity not in mapping:
            continue
        previous = None
        for state in states:
            value = state.get("state")
            stamp = state.get("last_changed") or state.get("last_updated")
            if not stamp:
                continue
            parsed = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                raise ValueError("HA timestamp lacks timezone")
            ts = parsed.timestamp()
            # Initial HA state can precede the requested period: never invent
            # a detection at the start of the day from that carry-in state.
            if value == "on" and previous != "on" and start <= ts < end:
                events[(entity, ts)] = {"type": mapping[entity], "timestamp": ts}
            previous = value
    return sorted(events.values(), key=lambda item: (item["timestamp"], item["type"]))


def enrich_partition(camera_id, key, generation):
    """One bounded history request per camera/day, never one per video."""
    try:
        _enrich(camera_id, key, generation)
    except Exception:
        # No URLs, tokens or HA payloads in logs. Video indexing remains valid.
        log.warning("HA enrichment failed for camera %s day %s", camera_id, key)


def _enrich(camera_id, key, generation):
    conn = get_db()
    try:
        camera = conn.execute("SELECT * FROM cameras WHERE id=?", (camera_id,)).fetchone()
        if not camera or not camera["ha_event_entities"]:
            return
        rows = conn.execute("SELECT * FROM recordings WHERE camera_id=? AND partition_key=? "
                            "AND availability='available'", (camera_id, key)).fetchall()
    finally:
        conn.close()
    if not rows or generation != index_generation():
        return
    mapping = parse_mapping(camera["ha_event_entities"])
    offset = camera["time_offset_seconds"] or 0
    day = datetime.fromisoformat(key).replace(tzinfo=ZoneInfo(camera["timezone"]))
    start, end = day.timestamp() + offset, (day + timedelta(days=1)).timestamp() + offset
    signature = hashlib.sha256(json.dumps([mapping, offset, camera["timezone"]], sort_keys=True).encode()).hexdigest()
    def row_signature(row):
        return signature + ":" + str((row["start_ts"], row["end_ts"], row["mtime"]))

    now = time.time()
    # Preserve historical results on routine rescans; refresh today's clips
    # and retry errors at most once per five minutes.
    targets = [r for r in rows if r["ha_events_signature"] != row_signature(r) or not r["ha_events_checked"] or
               ((r["ha_events_status"] == "error" or r["ha_events_checked"] < end) and now-r["ha_events_checked"] >= 300)]
    if not targets:
        return
    failed = False
    try:
        # Include short tails crossing midnight without an unbounded query.
        query_start = max(start - 86400, min(start, min(r["start_ts"] + offset for r in targets)))
        query_end = min(end + 86400, max(end, max((r["end_ts"] or r["start_ts"]) + offset for r in targets)))
        events = extract_events(fetch_history(mapping, query_start, query_end), mapping, query_start, query_end)
    except Exception as exc:
        code = exc.code if isinstance(exc, HAError) else "invalid_response"
        log.warning("HA history failed camera=%s day=%s code=%s status=%s",
                    camera_id, key, code, getattr(exc, "status", None))
        events, failed = [], True
    updates = []
    for row in targets:
        a, b = row["start_ts"] + offset, (row["end_ts"] or row["start_ts"]) + offset
        found = [e for e in events if a <= e["timestamp"] < b]
        old = json.loads(row["ha_events"]) if row["ha_events_signature"] == row_signature(row) else []
        merged = {(e["type"], e["timestamp"]): e for e in old + found}
        payload = sorted(merged.values(), key=lambda e: (e["timestamp"], e["type"]))
        status = "error" if failed else ("found" if payload else "unknown")
        updates.append((json.dumps(payload), status, now, row_signature(row), row["id"], row["path"]))
    with write_db() as conn:
        current = conn.execute("SELECT ha_event_entities, time_offset_seconds, timezone FROM cameras WHERE id=?", (camera_id,)).fetchone()
        if generation != index_generation() or not current or any(current[k] != camera[k] for k in current.keys()):
            return
        conn.executemany("UPDATE recordings SET ha_events=?, ha_events_status=?, ha_events_checked=?, "
                         "ha_events_signature=? WHERE id=? AND path=?", updates)
