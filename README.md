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
credentials. The Home Assistant app is restricted to administrators, who can
configure cameras, request scans and browse recordings.

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
the first segment and continues while the remaining recording is transcoded.
At 8x and 16x, compressed profiles sample source keyframes to reduce decoding
load and keep the transcoder ahead of playback.

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
gh workflow run promote-stable.yml \
  -f candidate=v0.2.0-beta.1 \
  -f version=0.2.0
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
python3 -m unittest discover -v
node --check ctv_web/js/i18n.js
node --check ctv_web/js/app.js
node --check ctv_web/js/timeline.js
node --check ctv_web/js/player.js
```

## License

Copyright (C) 2026 robertoamd90.

Licensed under the GNU General Public License v3.0 or later. See [LICENSE](LICENSE).
