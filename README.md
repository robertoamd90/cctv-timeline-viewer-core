# CCTV Timeline Viewer

Browse and synchronize recordings from multiple CCTV cameras on one shared
timeline. CCTV Timeline Viewer is vendor-independent and works with recordings
already available as files on the local filesystem.

## Features

- Synchronized playback across multiple cameras.
- Timeline navigation, zoom, day selection, and configurable camera layouts.
- Efficient day-based indexing for large local, SMB, and NFS archives.
- Read-only access to recordings.
- Native or server-transcoded playback profiles for slower client connections.
- Home Assistant Ingress support with administrator-only configuration.
- Home Assistant detection events saved alongside daily recording indexes.
- Event filters that also skip excluded clips during synchronized playback.
- Per-camera timed event badges with configurable placement.
- Manual and automatic Hotspot layouts and compact mobile controls.
- English and Italian user interfaces.

## Home Assistant

Home Assistant OS and Supervised are the primary supported deployments.

1. Open **Settings > Apps > App store > Repositories**.
2. Add the Home Assistant catalog repository:

   ```text
   https://github.com/robertoamd90/cctv-timeline-viewer
   ```

3. Install **CCTV Viewer**, start it, and enable **Show in sidebar**.
4. Configure each camera from the app using a source directory under `/media`.

The catalog also exposes **CCTV Viewer Beta** for testing the upcoming release
line. It uses separate app data and the `cctv-viewer-beta` container image, so
it can be installed alongside the stable app without changing it.

The add-on mounts Home Assistant Media read-only. Configure SMB/NFS storage in
Home Assistant first; CCTV Viewer does not mount network shares or store their
credentials. All Home Assistant users can open the app, browse the timeline and play recordings.
Only administrators see Cameras and can change configuration or request manual scans.

The published add-on supports `amd64` and `aarch64`. Its SQLite index is stored
under `/data` and included in cold backups. Generated thumbnails are excluded
from backups because they can be rebuilt.

## Standalone

### Requirements

- Python 3.11 or later
- `ffmpeg` and `ffprobe`

```bash
git clone https://github.com/robertoamd90/cctv-timeline-viewer-core.git
cd cctv-timeline-viewer-core
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m uvicorn ctv_server.main:app --host 0.0.0.0 --port 8000
```

Open `http://localhost:8000`. Use `--reload` only during development.

Standalone mode has no built-in authentication. Use it on a trusted network or
behind an authenticated reverse proxy.

## Docker

```bash
docker build -t cctv-viewer .
docker run --name cctv-viewer -p 8000:8000 \
  -v ctv-data:/root/.ctv \
  -v /mnt/cctv:/sources/cctv:ro \
  cctv-viewer
```

Add cameras with a container-visible path, for example
`/sources/cctv/garage`. The `:ro` mount prevents the application from changing
the original recordings.

## Timeline and camera layouts

Choose a day to load its recordings, select the visible cameras from **Cameras**
and use the timeline to seek, pan or zoom. The overview helps navigate a dense
day; drag the divider above the timeline to resize it. Thumbnails are generated
in the background and can appear after recording segments first load.

Grid layouts show cameras together. **Hotspot** gives one camera the larger
position; select a camera to promote it manually. **Auto** in Hotspot mode
promotes the camera whose recording starts most recently during playback.
This follows recording starts, not HA detection priority. Selecting a camera
manually returns Hotspot to manual selection. Available grid and paging controls
depend on screen size and the selected layout.

## Recording Sources

CCTV Timeline Viewer works with directories visible to its process. SMB and NFS
shares must be mounted by the host before starting the application; FTP is not a
supported source type.

For large or remote archives, configure cameras with the date-partitioned
layout `{YYYY}/{MM}/{DD}`. The app reads only the day directories needed by the
current timeline and keeps a local cache. It does not assume a retention period:
files and days disappear from the index when they no longer exist on the source.

If a camera includes pre-event footage before the timestamp encoded in its file
name, set its **Recording time offset** in seconds. For example, choose
**Earlier (-)** and enter `5` when a file named `12:00:05` starts with footage
from `12:00:00`. Changing the value also adjusts recordings already indexed, so
a full rescan is not required.

Administrators can use **Rebuild index** from the Cameras view to clear derived
recordings, loaded day partitions and generated thumbnails without deleting
camera settings or source files. Days are indexed again only when opened from
the timeline. The action is unavailable while an indexing job is active.

## Automatic indexing of today

In **Cameras**, open the general **Automatic indexing — all cameras** section
and enable **Index today in the background**. Set the **Interval (minutes)**
and use **Save automatic indexing**. One global setting covers every camera
using date-partitioned indexing;
automatic indexing is off by default and the suggested interval is 60 minutes.
The accepted range is 1–10080 minutes. Cameras using recursive indexing are
excluded. When upgrading from beta 1, the new global setting starts disabled
at 60 minutes; enable it once to apply it to all supported cameras. Previous
per-camera toggles are no longer used. Recordings and saved events are preserved.

The server runs the schedule even with the browser closed. Enabling it makes
an initial scan due; later runs wait the configured interval after the previous
attempt completes. The scheduler checks due work roughly every ten seconds and
processes cameras sequentially, so busy periods can delay a run. Attempts that
fail, including an offline NAS, also wait the configured interval before retry.
Saved schedules survive restarts; interrupted jobs become eligible again.

Only the **current day's directory in the camera's timezone** is scanned. At
midnight the next due check switches to the new day. Missed days are not caught
up automatically. Open a previous day to refresh its index normally.

Every automatic run still enumerates the filenames in today's directory and
its subdirectories. It inspects metadata and probes only new or unsettled files,
using one probe worker. A file is considered settled after it is observed with
unchanged size and modification time, has a valid duration, and its modification
time is at least two minutes old. This is a stability heuristic, not a file-close
notification: unusual writers that resume after a long pause may require a
normal timeline refresh. Settled files are skipped before explicit metadata
queries; underlying NAS/client directory enumeration can still read metadata.

Automatic scans do not reconcile removals or replacements of settled files.
Opening a day retains the normal full reconciliation (subject to the existing
refresh cache). Interactive partition requests take priority over the next
background job; a scan already running finishes first. The initial scan of a
large day still has to inspect its files, so choose an interval suitable for the
NAS. Logs report listing time, inspected/new/updated file counts and total
indexing time to help assess the load.

Automatic daily indexing also enriches recordings with configured HA events.
It creates no video copies and does not fetch historical days in the background.
Disabling it stops future scheduled scans; an already running scan can finish.
The previous recently-viewed-partition watcher is replaced by these explicit
global settings; `CTV_WATCHER_SECONDS` no longer controls background scans.

## Detection events from Home Assistant

Event enrichment is available in the Home Assistant app through the Supervisor
connection. Standalone and generic Docker deployments can browse recordings,
but do not provide this HA connection automatically. No extra token needs to be
entered in the Home Assistant app.

### Configure each camera

1. Open **Cameras**, select the camera and configure daily partition indexing
   with the directory pattern matching your archive, such as `{YYYY}/{MM}/{DD}`.
2. In the event fields, type part of a sensor's friendly name or entity ID and
   select a result from the dropdown. There is one field each for **Person**,
   **Vehicle**, **Animal**, **Motion** and **Doorbell**, with one entity per field.
3. Use `binary_sensor` entities whose `on` state means the detection is active.
   A camera entity or an HA event entity is not a supported substitute. Leave
   types your camera does not support empty. Use **×** to clear a selection.
4. Choose the video badge position: top-left, top-center, top-right, bottom-left,
   bottom-center or bottom-right. The default is top-right.
5. Select **Save camera**. Sensor selections, removals and badge position apply
   only on save. Select the camera again later to review its saved associations.

The app reads sensor history when it indexes a requested or automatically scheduled day and associates
intervals with that day's recordings. Changing associations makes indexed days
eligible for refresh when requested again. Merely saving a camera does not
collect its entire historical archive. A sensor-list connection error preserves
saved associations: retry after HA connectivity is restored.

### Find and play detections

Timeline clips show an icon for each associated event type. Select an icon to
seek to the first detection of that type in the clip, with up to ten seconds of
lead-in, limited to the clip start. Person uses a moving-person icon; generic
motion uses an abstract motion symbol.

Open **Events** in the timeline toolbar and select one or more types. Selections
use **OR**: Vehicle plus Person includes clips containing either type, as well as
clips containing both. The camera filter still controls which cameras you see.
**Show all**, or clearing every event checkbox, restores all recordings. The
event selection applies to the current page session.

Filtering keeps **whole matching clips**, including footage before and after a
selected detection. Playback skips excluded recordings. When no displayed
camera has a matching clip at the current time, playback jumps to the next
matching clip; cameras without a matching clip remain blank. If nothing matches,
playback stops with a message. Clips without saved matching events are excluded,
even if their footage might contain an undetected or unindexed event.

### Badges and synchronization

Each camera displays badges for its active events over its own video, including
other event types present in a clip selected by the filter. Badges follow the
video timestamp during playback, seeking and speed changes. Known `on`/`off`
intervals determine duration; if the end is missing, the fallback is **three
seconds of recorded time**. These are historical detections displayed during
playback, not new live detection or video analysis.

Badges sit inside the displayed image, excluding black letterbox bars. Small
screens use icons without text. The top-left position leaves room for the camera
name. The mobile toolbar can collapse its date and view controls using the
chevron while keeping playback controls available.

**Recording time offset is already accounted for.** For example, a filename
of `12:00:05` with an Earlier offset of 5 seconds starts on the timeline at
`12:00:00`. An HA detection at `12:00:02` belongs two seconds into that video.
Do not apply the recording offset again to the HA event. This aligns timestamps;
it does not compensate for a sensor's own reporting latency or an incorrect
camera clock. After changing an offset, event associations refresh when the day
is reindexed.

### Historical coverage, retention and backups

HA must still retain the sensor history when a day is first indexed. Opening a
day from five months ago cannot recover events HA has already discarded. Once
associated, events are stored with recording records in CCTV Viewer's SQLite
index and can remain visible after HA history expires. Routine rescans and
temporary HA failures preserve cached events; missing history is not treated as
proof of no activity. Event enrichment currently uses daily partitions, not
recursive indexing, and there is no continuous background event collector.

**Rebuild index deletes saved events**, along with recording records and
thumbnails. Removing a camera or removing its recording records also removes
those events. Reindexing can restore them only if HA still has the history.
Back up the app database before rebuilding if the saved historical events
matter. Camera settings and original videos survive an index rebuild. No second
video archive is created. Beta and stable have separate data: promoting the
software does not migrate cameras or event history between their installations.

## Streaming Quality

The **Stream** menu stores two preferences in the current browser:

- **Native** sends the original recording unchanged.
- **Balanced** and **Fast** transcode the original on the CCTV Viewer server
  before sending it to the browser. The NAS-to-server read remains native.
- **Metadata** preload minimizes traffic while paused. **Automatic** lets the
  browser preload more data and can start playback sooner at the cost of
  bandwidth and server work.

Administrators can configure the scale percentage, output frame rate and
maximum bitrate of Balanced and Fast from the Cameras view. Percentage scaling
preserves the source aspect ratio for both 4:3 and 16:9 recordings. Accelerated
playback is encoded into compressed streams, so selecting 16x does not ask the
browser to consume sixteen times the configured bitrate.

Transcoding consumes CPU on the machine running CCTV Viewer. Native remains the
best choice on a fast local network; Balanced and Fast target VPN, mobile and
other bandwidth-constrained connections. Compressed profiles use native HLS
delivery on iPhone, iPad and other WebKit clients, while supported desktop
browsers continue to receive fragmented MP4. Mobile HLS playback starts after
one segment at 1x, two at 4x, and four at 8x/16x (or when the clip completes).
At 8x and 16x, compressed profiles sample source keyframes at clip boundaries;
seeks use normal decoding so short tails still produce frames. HLS input pacing
is disabled at these speeds to avoid delayed startup after a seek.

The Cameras view also exposes **Server resources**, including a shared limit
for simultaneous compressed streams and an HLS temporary-space budget (256 MiB
by default). The stream limit covers MP4, HLS and all viewers. Its default `0`
preserves unlimited concurrency; choose a limit appropriate to the server.
Lowering this limit affects new admissions, leaving existing streams running.
If capacity is exhausted, playback pauses with a message and a retry button;
select fewer cameras or wait for another viewer before retrying. Cameras are
never silently dropped from a synchronized grid.

Compressed playback reuses aligned streams when buffering. A source that
is already playing uses a lower buffer threshold than a recovering source,
reducing repeated short pauses. A source that
cannot be realigned is restarted individually, with a finite retry budget and
a 30-second recovery timeout. Pausing retains incomplete streams for up to two
seconds, then releases them; fully downloaded MP4 buffers can be reused without
another encode. Leaving the page releases compressed sessions and returning
does not automatically resume playback. Server watchdogs cover lost client
cancellation requests.

HLS temporary files are checked every half second. If their total exceeds the
budget, whole sessions are invalidated and removed, preferring older completed
sessions. This is a watchdog budget, not an exact filesystem quota: in-flight
output can temporarily exceed it between checks. It does not create a second
archive or modify original recordings. A storage-limit message lets the viewer
retry with fewer cameras or a lower bitrate.

Resource settings persist in the application's database and work through Home
Assistant Ingress. `CTV_MAX_TRANSCODERS` and `CTV_HLS_TEMP_MB` seed the initial
settings when a database is first upgraded; subsequent changes use the UI.

Supported recording extensions are MP4, AVI, MKV, MOV, TS, H264, H265, and DAV.
Image files, including JPEG snapshots, are ignored. Browser compatibility still
depends on the actual codec; H.264 video in MP4 or MOV is recommended.

## Repository Layout

```text
ctv_server/                 FastAPI backend and SQLite index
ctv_web/                    Vanilla JavaScript frontend
packaging/homeassistant/    Templates for local Supervisor builds
scripts/                    Development and release tools
tests/                      Backend and browser-independent frontend tests
```

This repository contains the application source and produces immutable release
requests. The separate
[`cctv-timeline-viewer`](https://github.com/robertoamd90/cctv-timeline-viewer)
repository is the Home Assistant catalog and contains only public manifests,
documentation and release state. Home Assistant keeps using that original URL.

`main` is the only long-lived source branch. Beta and stable are distribution
channels represented by immutable tags, not by branches. A beta tag such as
`v0.2.0-beta.1` requests a multi-architecture Beta image from the catalog.
Stable promotion copies the already tested Beta image to its stable version;
it does not rebuild application code.

To publish a beta after updating the target version section in `CHANGELOG.md`:

```bash
git tag -a v0.2.0-beta.1 -m "CCTV Viewer 0.2.0 Beta 1"
git push origin v0.2.0-beta.1
```

After validating that candidate, promote the exact artifact:

```bash
candidate=v0.2.0-beta.1
version=0.2.0
source_sha="$(git rev-list -n 1 "$candidate")"
git tag -a "v$version" "$source_sha" -m "CCTV Viewer $version"
git push origin "v$version"
gh workflow run promote-stable.yml \
  -f candidate="$candidate" \
  -f version="$version"
```

The source workflow writes a release request to the catalog. The catalog owns
GHCR publication, verifies both supported architectures and updates the Home
Assistant manifest only after the image is available. Source `main` therefore
never receives generated release commits. Operational details, recovery and
rollback procedures are documented in [RELEASING.md](RELEASING.md).

For a local Supervisor build without publishing an image, run this from the
repository root:

```bash
./scripts/package-local-addon.sh
```

It generates the ignored `addons/cctv_viewer/` build context. This is a
disposable test artifact, not a second source tree; never edit it manually.
Pass `stable` or `beta` to generate only one channel.

## Development Checks

```bash
pip install -r requirements-dev.txt
python3 -m unittest discover -s tests -v
node tests/test_media.js
node tests/test_player_recovery.js
node tests/test_hotspot.js
node tests/test_event_picker.js
node tests/test_event_playback.js
node tests/test_camera_form.js
node tests/test_mobile_layout.js
node --check ctv_web/js/i18n.js
node --check ctv_web/js/app.js
node --check ctv_web/js/timeline.js
node --check ctv_web/js/player.js
```

The synthetic performance checks use temporary databases and never access the
configured CCTV archive:

```bash
python3 scripts/benchmark_performance.py --recordings 1000000
python3 scripts/benchmark_indexer.py
node scripts/benchmark_frontend.js
```

Playback diagnostics are available from `/api/playback-status` and, for a known
session ID, `/api/playback-sessions/{id}`. The browser's
`window.ctvPlaybackDiagnostics()` reports bounded first-frame samples, total
buffering time, recoveries and restarts. Server session diagnostics contain no
recording paths. The first server output can be MP4 metadata; it is distinct
from the first decoded browser frame.

`scripts/create_playback_fixture.py` creates a new isolated directory containing
synthetic video and two test databases. `scripts/benchmark_playback_browser.cjs`
compares fixture servers on ports 8766 (baseline) and 8765 (candidate), using
Playwright installed separately from the application. For sustained bandwidth
and interruption tests, run `scripts/playback_test_proxy.py` on ports 8776 and
8775 and set `CTV_BENCHMARK_PROXY=1`. Set `CTV_PLAYWRIGHT_MODULE` to the installed
module path, `CTV_CHROME_EXECUTABLE` to a Chrome executable if needed, and
`CTV_BENCHMARK_OUTPUT` for the JSON report. These tests must target fixture
servers, never a configured production archive.

`python3 scripts/benchmark_transcoding.py` compares progressive input pacing
with the current backpressure behavior using synthetic media, and reports first
fragment time, generated bytes and FFmpeg CPU time. No benchmark requires
duplicating surveillance recordings.

## License

Copyright (C) 2026 robertoamd90.

Licensed under the GNU General Public License v3.0 or later. See [LICENSE](LICENSE).
