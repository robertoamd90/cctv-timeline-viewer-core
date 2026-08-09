import os
import re
import hashlib
import logging
import math
import subprocess
import json
from typing import Optional
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

VIDEO_EXTENSIONS = {".mp4", ".avi", ".mkv", ".mov", ".ts", ".h264", ".h265", ".dav"}
log = logging.getLogger("ctv.ffprobe")

# Regex per estrarre timestamp da nomi file come:
#   CAM-Esterno_00_20260706002901.mp4
#   camera01_2026-07-06_14-30-00.mp4
#   20260706_002901.mp4
TIMESTAMP_PATTERNS = [
    re.compile(r"(\d{4})(\d{2})(\d{2})_?(\d{2})(\d{2})(\d{2})"),  # 20260706_002901
    re.compile(r"(\d{4})-(\d{2})-(\d{2})_?(\d{2})-?(\d{2})-?(\d{2})"),  # 2026-07-06_14-30-00
    re.compile(r"(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})"),  # 20260706002901
]


def scan_directory(source_path: str) -> list[dict]:
    """Trova solo i file video supportati in una directory (ricorsivo)."""
    if not os.path.isdir(source_path):
        raise FileNotFoundError(f"Sorgente non disponibile: {source_path}")
    files = []
    pending_directories = [source_path]
    while pending_directories:
        directory = pending_directories.pop()
        with os.scandir(directory) as entries:
            for entry in entries:
                if entry.is_dir(follow_symlinks=False):
                    pending_directories.append(entry.path)
                    continue
                # os.walk does not descend into directory symlinks and does
                # not expose them as files; retain that behavior.
                if entry.is_symlink():
                    try:
                        if entry.is_dir(follow_symlinks=True):
                            continue
                    except FileNotFoundError:
                        continue
                ext = Path(entry.name).suffix.lower()
                if ext not in VIDEO_EXTENSIONS:
                    continue
                try:
                    stat = entry.stat(follow_symlinks=True)
                except FileNotFoundError:
                    continue
                files.append({
                    "path": entry.path,
                    "filename": entry.name,
                    "ext": ext,
                    "size": stat.st_size,
                    "mtime": stat.st_mtime,
                })
    files.sort(key=lambda item: item["path"])
    return files


def extract_timestamp(filename: str, filepath: str, tz_name: str = "UTC") -> Optional[float]:
    """Prova a estrarre il timestamp dal nome file via regex.
    Interpreta la data/ora nel timezone indicato e restituisce timestamp UTC."""
    for pattern in TIMESTAMP_PATTERNS:
        m = pattern.search(filename)
        if m:
            try:
                y, mo, d, h, mi, s = map(int, m.groups())
                tz = ZoneInfo(tz_name) if tz_name != "UTC" else timezone.utc
                dt = datetime(y, mo, d, h, mi, s, tzinfo=tz)
                return dt.timestamp()
            except (ValueError, KeyError):
                continue
    return None


def get_ffprobe_data(filepath: str) -> dict:
    """Estrae metadati video via ffprobe."""
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error", "-print_format", "json",
                "-show_format", "-show_streams", filepath,
            ],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode != 0:
            detail = (result.stderr or "unknown ffprobe error").strip()[-500:]
            log.warning(
                "ffprobe failed for %s (exit %d): %s",
                os.path.basename(filepath), result.returncode, detail,
            )
            return {}
        return json.loads(result.stdout)
    except FileNotFoundError:
        log.error("ffprobe executable is unavailable")
        return {}
    except subprocess.TimeoutExpired:
        log.warning("ffprobe timed out for %s", os.path.basename(filepath))
        return {}
    except json.JSONDecodeError as exc:
        log.warning("ffprobe returned invalid JSON for %s: %s", os.path.basename(filepath), exc)
        return {}


def _positive_float(value) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return 0.0
    return parsed if math.isfinite(parsed) and parsed > 0 else 0.0


def _stream_duration(stream: dict) -> float:
    direct = _positive_float(stream.get("duration"))
    if direct:
        return direct
    duration_ts = _positive_float(stream.get("duration_ts"))
    time_base = stream.get("time_base", "")
    try:
        numerator, denominator = (float(part) for part in time_base.split("/", 1))
    except (TypeError, ValueError):
        return 0.0
    if not duration_ts or denominator <= 0:
        return 0.0
    return _positive_float(duration_ts * numerator / denominator)


def parse_ffprobe(probe: dict) -> dict:
    """Estrae i campi rilevanti dall'output ffprobe."""
    fmt = probe.get("format", {})
    video_stream = None
    for stream in probe.get("streams", []):
        if stream.get("codec_type") == "video":
            video_stream = stream
            break

    duration = _positive_float(fmt.get("duration"))
    if not duration and video_stream:
        duration = _stream_duration(video_stream)
    info = {
        "duration": duration,
        "codec": video_stream.get("codec_name", "") if video_stream else "",
        "resolution": f"{video_stream.get('width', 0)}x{video_stream.get('height', 0)}" if video_stream else "",
        "fps": 0.0,
        "creation_time": None,
    }

    # FPS
    if video_stream:
        fps_str = video_stream.get("r_frame_rate", "0/1")
        if "/" in fps_str:
            try:
                num, den = fps_str.split("/")
                info["fps"] = _positive_float(float(num) / float(den)) if float(den) != 0 else 0.0
            except (TypeError, ValueError):
                info["fps"] = 0.0

    # Timestamp dai metadati
    tags = fmt.get("tags", {})
    for key in ("creation_time", "date"):
        if key in tags:
            try:
                dt = datetime.fromisoformat(tags[key].replace("Z", "+00:00"))
                info["creation_time"] = dt.timestamp()
                break
            except (ValueError, TypeError):
                pass

    return info


def hash_file(filepath: str, chunk_size: int = 8192) -> str:
    """Hash SHA256 del file (primi 64KB + ultimi 64KB + dimensione)."""
    size = os.path.getsize(filepath)
    h = hashlib.sha256()
    h.update(str(size).encode())
    with open(filepath, "rb") as f:
        # Primi 64KB
        h.update(f.read(65536))
        # Ultimi 64KB
        if size > 131072:
            f.seek(-65536, os.SEEK_END)
            h.update(f.read(65536))
    return h.hexdigest()[:16]
