"""Modelli Pydantic per validazione richieste API."""

from pydantic import BaseModel, Field, field_validator
from typing import Optional


class EventMapping(BaseModel):
    ha_event_entities: str = Field(default="", max_length=4096)

    @field_validator("ha_event_entities")
    @classmethod
    def validate_event_entities(cls, value):
        from ctv_server.recording_events import parse_mapping
        parse_mapping(value)
        return value.strip()


class CameraCreate(EventMapping):
    name: str = Field(..., min_length=1, max_length=255, description="Nome della telecamera")
    source_path: str = Field(..., min_length=1, description="Percorso sorgente delle registrazioni")
    timezone: str = Field(default="", description="Timezone (es. Europe/Rome). Vuoto = auto-detect dal sistema")
    time_offset_seconds: float = Field(default=0, ge=-3600, le=3600)
    indexing_mode: str = Field(default="partitioned", pattern="^(partitioned|full)$")
    directory_pattern: str = Field(default="{YYYY}/{MM}/{DD}", min_length=1)


class CameraUpdate(EventMapping):
    name: str = Field(..., min_length=1, max_length=255)
    source_path: str = Field(..., min_length=1)
    timezone: str = Field(..., min_length=1)
    time_offset_seconds: float = Field(default=0, ge=-3600, le=3600)
    indexing_mode: str = Field(default="partitioned", pattern="^(partitioned|full)$")
    directory_pattern: str = Field(default="{YYYY}/{MM}/{DD}", min_length=1)


class CameraResponse(EventMapping):
    id: int
    name: str
    source_path: str
    timezone: str
    time_offset_seconds: float = 0
    config: str = "{}"
    indexing_mode: str = "partitioned"
    directory_pattern: str = "{YYYY}/{MM}/{DD}"
    source_status: str = "unknown"
    source_error: Optional[str] = None
    last_scan_started: Optional[float] = None
    last_scan_completed: Optional[float] = None
    recordings_available: int = 0
    recordings_missing: int = 0


class ScanResult(BaseModel):
    status: str
    camera_id: Optional[int] = None
    cameras: Optional[int] = None


class StreamProfileConfig(BaseModel):
    scale_percent: int = Field(..., ge=20, le=100)
    fps: int = Field(..., ge=2, le=30)
    bitrate_kbps: int = Field(..., ge=100, le=8000)


class StreamProfilesUpdate(BaseModel):
    balanced: StreamProfileConfig
    fast: StreamProfileConfig


class PlaybackSettings(BaseModel):
    max_transcoders: int = Field(..., ge=0, le=64)
    hls_temp_mb: int = Field(..., ge=16, le=4096)


class PlaybackRequest(BaseModel):
    session_id: str = Field(..., pattern="^[a-f0-9]{32}$")
    recording_id: int = Field(..., ge=1)
    profile: str = Field(..., pattern="^(balanced|fast)$")
    start: float = Field(0, ge=0, allow_inf_nan=False)
    speed: float = Field(1, ge=1, le=16, allow_inf_nan=False)
    transport: str = Field(..., pattern="^(mp4|hls)$")
