/* ═══════════════════════════════════════════
   CTV — Player: all cameras always visible, global clock, transitions
   ═══════════════════════════════════════════ */

let _clockStartTime = null, _clockStartWall = null, _tickId = null;
let _playerCache = {};  // camId → {recId, sourceKey}
let _wasBuffering = false;
let _lastPlaybackUiUpdate = 0;
let _recoveryStarted = null;
let _playbackEpoch = 0;
const _pendingReleases = new Set();
const playbackDiagnostics = {bufferingMs: 0, recoveries: 0, restarts: 0, firstFrames: []};
window.ctvPlaybackDiagnostics = () => ({...playbackDiagnostics,
  firstFrames: playbackDiagnostics.firstFrames.slice(),
  bufferingMs: playbackDiagnostics.bufferingMs + (_recoveryStarted == null ? 0 : performance.now() - _recoveryStarted)});
const _nativeMediaCacheToken = Date.now().toString(36);

function playerSourceKey(rec) {
  if (!rec) return '';
  const plan = CtvMedia.playbackPlan(S.streamProfile, S.speed);
  return `${rec.id}:${S.streamProfile}:${plan.streamSpeed}:${S.streamProfileRevision}`;
}

function videoPlaybackRate(video) {
  const value = parseFloat(video.parentElement.dataset.playbackRate);
  return Number.isFinite(value) && value > 0 ? value : S.speed;
}

function videoTimelineSpeed(video) {
  return CtvMedia.timelinePlaybackSpeed(
    videoPlaybackRate(video),
    parseFloat(video.parentElement.dataset.streamSpeed),
  );
}

function videoTargetTime(video, globalTime = S.currentTime) {
  const cell = video.parentElement;
  return CtvMedia.mediaTimeForTimeline(
    globalTime,
    parseFloat(cell.dataset.start),
    parseFloat(cell.dataset.streamOffset) || 0,
    parseFloat(cell.dataset.streamSpeed) || 1,
    parseFloat(cell.dataset.duration),
  );
}

function supportsNativeHls(video) {
  const mobilePlayback = navigator.maxTouchPoints > 0 &&
    window.matchMedia('(pointer: coarse)').matches;
  if (!mobilePlayback) return false;
  return Boolean(video.canPlayType('application/vnd.apple.mpegurl') ||
    video.canPlayType('application/x-mpegURL'));
}

function streamSessionId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID().replaceAll('-', '');
  }
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)))
    .map(value => value.toString(16).padStart(2, '0')).join('');
}

function cancelHlsSource(video) {
  if (!video) return;
  clearTimeout(video._pauseTimer);
  video._generation = (video._generation || 0) + 1;
  const jobId = video.parentElement?.dataset.transcodeJob || video.parentElement?.dataset.hlsJob;
  video.pause();
  video.onended = video.onwaiting = video.onstalled = video.onerror = null;
  video.removeAttribute('src');
  video.load();
  if (!jobId) return;
  video.parentElement.dataset.hlsJob = '';
  video.parentElement.dataset.transcodeJob = '';
  video.parentElement.dataset.hlsCancelled = '1';
  const release = releasePlaybackSession(jobId);
  _pendingReleases.add(release);
  release.finally(() => _pendingReleases.delete(release));
}

async function releasePlaybackSession(jobId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    await fetch(appUrl(`/api/playback-sessions/${jobId}`), {method: 'DELETE', keepalive: true, signal: controller.signal});
  } catch (_) { /* Server watchdogs cover a lost cancellation request. */ }
  finally { clearTimeout(timer); }
}

function resetPlaybackRecovery() {
  _playbackEpoch++;
  finishRecovery();
  getVideos().forEach(video => { video.dataset.recoveryAttempts = '0'; });
  document.getElementById('playback-notice').hidden = true;
}

function finishRecovery() {
  if (_recoveryStarted != null) playbackDiagnostics.bufferingMs += performance.now() - _recoveryStarted;
  _recoveryStarted = null;
}

function failPlayback(code = 'recoveryFailed') {
  stopPlayback(true);
  const known = ['capacity', 'storage_limit', 'encoding', 'recoveryFailed', 'session_expired'];
  document.getElementById('playback-notice-text').textContent = t(`player.${known.includes(code) ? code : 'unplayable'}`);
  document.getElementById('playback-notice').hidden = false;
}

function schedulePausedRelease(video) {
  clearTimeout(video._pauseTimer);
  const generation = video._generation;
  video._pauseTimer = setTimeout(() => {
    if (!S.playing && video._generation === generation) {
      const duration = Number(video.parentElement.dataset.duration);
      if (video.parentElement.dataset.streamTransport === 'mp4' && Number.isFinite(duration) &&
          duration > 0 && bufferedAheadAt(video, video.currentTime) >= duration - video.currentTime - 0.15) {
        // A fully downloaded MP4 no longer needs a producer or network traffic.
        // Keep its local buffer so a later Play does not encode it again.
        return;
      }
      showFreezeFrame(video);
      cancelHlsSource(video);
    }
  }, 2000);
}

async function loadCompressedSource(video, request, url) {
  const generation = video._generation;
  try {
    // Wait for superseded sources to release their slots before admission.
    await Promise.all([..._pendingReleases]);
    if (generation !== video._generation) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    let response;
    try {
      response = await fetch(appUrl('/api/playback-sessions'), {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(request), signal: controller.signal,
      });
    } finally { clearTimeout(timer); }
    if (generation !== video._generation) {
      releasePlaybackSession(request.session_id);
      return;
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      failPlayback(body.detail);
      return;
    }
    video.src = url;
    video.dataset.warming = '0';
    video.load();
    if (S.playing) enterBufferingBarrier(null, null);
    else schedulePausedRelease(video);
  } catch (_) {
    if (generation === video._generation) failPlayback('unplayable');
  }
}

function hasCancelledHlsSources() {
  return getVideos().some(video => video.parentElement.dataset.hlsCancelled === '1');
}

function seekVideo(video) {
  if (S.currentTime == null || video.readyState < HTMLMediaElement.HAVE_METADATA) return false;
  const target = videoTargetTime(video);
  // Progressive transcoding is positioned through its URL start offset and
  // cannot be sought in place. Mid-stream realignment reopens that URL.
  if (video.parentElement.dataset.streamTransport === 'mp4') return true;
  // Reassigning an existing zero position before the first frame is decoded
  // creates a redundant browser seek.
  const needsMetadataSeek = video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA &&
    target > 0.05;
  if (needsMetadataSeek ||
      (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
       Math.abs(video.currentTime - target) > 0.05)) {
    video.currentTime = target;
  }
  return true;
}

// ── Render tutti i player ──
function renderPlayers(forceReload = false) {
  const area = document.getElementById('player-area');
  const displayed = displayedCameras();
  const camIds = displayed.map(c => c.id);

  // Rimuovi celle per camere rimosse
  area.querySelectorAll('.player-cell').forEach(cell => {
    const cid = parseInt(cell.dataset.cam);
    if (!camIds.includes(cid)) {
      cancelHlsSource(cell.querySelector('video'));
      delete _playerCache[cid];
      cell.remove();
    }
  });

  // Crea/aggiorna celle per ogni camera
  camIds.forEach((cid, idx) => {
    let cell = area.querySelector(`.player-cell[data-cam="${cid}"]`);
    const cam = displayed.find(c => c.id === cid);
    const rec = findRecordingAt(cid, S.currentTime);

    if (!cell) {
      cell = document.createElement('div');
      cell.className = 'player-cell';
      cell.dataset.cam = String(cid);
      cell.ondblclick = () => {
        if (!isCompactViewport()) toggleCameraFocus(cid);
      };
      cell.onclick = () => {
        if (isCompactViewport() && S.layoutMode !== 'hotspot') toggleCameraFocus(cid);
        else promoteHotspotCamera(cid);
      };
      const existing = area.querySelectorAll('.player-cell');
      if (idx < existing.length) area.insertBefore(cell, existing[idx]);
      else area.appendChild(cell);
      _playerCache[cid] = null;
    }
    // Mantiene l'ordine DOM allineato alla vista; in hotspot il primo elemento e quello principale.
    area.appendChild(cell);

    const cached = _playerCache[cid];
    const sourceKey = playerSourceKey(rec);
    const needUpdate = forceReload || !cached || cached.sourceKey !== sourceKey;
    if (needUpdate) {
      updatePlayerCell(cell, cam, rec, cid);
      _playerCache[cid] = { recId: rec ? String(rec.id) : '', sourceKey };
    }

    const video = cell.querySelector('video');
    if (video && rec && S.currentTime != null) {
      seekVideo(video);
    }
  });
  applyHotspotCellPositions();
  updateEventOverlays();
}

function updatePlayerCell(cell, cam, rec, cid) {
  const name = cam ? cam.name : '?';
  let v = cell.querySelector('video');
  if (!v) {
    cell.innerHTML = `<div class="label-overlay"></div>
      <div class="hotspot-action">${esc(t('player.bringToFront'))}</div>
      <div class="player-status" hidden></div>
      <div class="empty-state" hidden></div>
      <canvas class="player-freeze" hidden></canvas>
      <video muted playsinline webkit-playsinline disablepictureinpicture
        controlslist="nofullscreen nodownload noremoteplayback" preload="metadata" hidden></video>`;
    v = cell.querySelector('video');
    v.playsInline = true;
  }
  cancelHlsSource(v);
  cell.dataset.hlsJob = '';
  cell.querySelector('.label-overlay').textContent = name;
  cell.querySelector('.hotspot-action').textContent = t('player.bringToFront');
  const empty = cell.querySelector('.empty-state');

  if (rec) {
    const recId = String(rec.id);
    const originalDuration = rec.duration ??
      Math.max(0, (rec.end_ts ?? rec.start_ts) - rec.start_ts);
    const plan = CtvMedia.playbackPlan(S.streamProfile, S.speed);
    const maxOffset = Math.max(0, originalDuration - 0.05);
    const streamOffset = plan.transcoded
      ? Math.min(maxOffset, Math.max(0, (S.currentTime ?? rec.start_ts) - rec.start_ts))
      : 0;
    const streamDuration = plan.transcoded
      ? Math.max(0, (originalDuration - streamOffset) / plan.streamSpeed)
      : originalDuration;
    cell.dataset.recording = recId;
    v.dataset.recording = recId;
    cell.dataset.start = String(rec.start_ts);
    cell.dataset.streamOffset = String(streamOffset);
    cell.dataset.streamSpeed = String(plan.streamSpeed);
    cell.dataset.playbackRate = String(plan.playbackRate);
    cell.dataset.duration = String(streamDuration);
    cell.dataset.profile = S.streamProfile;
    cell.dataset.streamTransport = '';
    cell.dataset.transitioning = '';
    cell.dataset.buffering = '1';
    cell.dataset.failed = '0';
    v.dataset.hasPlayed = '0';
    v.dataset.metadataReady = '0';
    v.dataset.driftSeek = '0';
    v.dataset.warming = '0';
    clearFreezeFrame(v);
    empty.hidden = true;
    v.hidden = false;
    setPlayerStatus(cell, t('player.loading'));
    v.pause();
    v.playbackRate = plan.playbackRate;
    v.loop = false;
    v.onended = () => {
      if (v.dataset.metadataReady !== '1' || v.dataset.hasPlayed !== '1') return;
      if (_wasBuffering || v.dataset.warming === '1') {
        if (cell.dataset.streamTransport === 'mp4' && v.ended) {
          onVideoEnded(v, recId);
          return;
        }
        v.pause();
        seekVideo(v);
        return;
      }
      if (videoReachedEnd(v)) {
        onVideoEnded(v, recId);
        return;
      }
      enterBufferingBarrier(v, t('player.buffering'));
      v.play().catch(() => {});
    };
    v.onloadedmetadata = () => {
      v.dataset.metadataReady = '1';
      seekVideo(v);
    };
    const loadedAt = performance.now();
    let firstFrame = true;
    v.onloadeddata = () => {
      if (firstFrame) {
        firstFrame = false;
        playbackDiagnostics.firstFrames.push({session: cell.dataset.transcodeJob || 'native', ms: performance.now() - loadedAt});
        if (playbackDiagnostics.firstFrames.length > 64) playbackDiagnostics.firstFrames.shift();
      }
      clearStatusWhenReady(v);
      updateEventOverlays();
    };
    v.oncanplay = () => { clearStatusWhenReady(v); updateEventOverlays(); };
    v.onseeked = () => {
      v.dataset.driftSeek = '0';
      clearStatusWhenReady(v);
      updateEventOverlays();
    };
    v.onplaying = () => {
      v.dataset.hasPlayed = '1';
      if (_wasBuffering) {
        showFreezeFrame(v);
        // Native HLS must advance to refresh its playlist. Progressive MP4
        // keeps downloading while paused and must stay at its zero-time anchor.
        const keepHlsWarming = v.dataset.warming === '1' &&
          cell.dataset.streamTransport === 'hls';
        if (!keepHlsWarming) v.pause();
        return;
      }
      setPlayerStatus(cell, '');
    };
    v.onwaiting = () => {
      if (v.dataset.driftSeek !== '1') {
        enterBufferingBarrier(v, t('player.buffering'));
        return;
      }
      const waitingRecording = v.dataset.recording;
      const waitingSource = v.src;
      const waitingEpoch = _playbackEpoch;
      setTimeout(() => {
        if (S.playing && v.dataset.recording === waitingRecording &&
            v.src === waitingSource && waitingEpoch === _playbackEpoch &&
            v.dataset.driftSeek === '1' &&
            v.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
          enterBufferingBarrier(v, t('player.buffering'));
        }
      }, 250);
    };
    v.onstalled = () => {
      if (!videoHasPlaybackBuffer(v)) enterBufferingBarrier(v, t('player.buffering'));
    };
    v.onerror = async () => {
      const generation = v._generation;
      const jobId = cell.dataset.transcodeJob;
      const status = jobId ? await fetch(appUrl(`/api/playback-sessions/${jobId}`))
        .then(response => response.json()).catch(() => ({})) : {};
      if (v._generation !== generation) return;
      clearFreezeFrame(v);
      cell.dataset.failed = '1'; cell.dataset.buffering = '0';
      setPlayerStatus(cell, t('player.unplayable'), true);
      failPlayback(status.reason || 'unplayable');
    };
    // This is a per-browser preference because preload behavior varies by
    // engine and connection. Browsers may still treat it as a hint.
    v.preload = S.preloadMode;
    if (plan.transcoded) {
      const jobId = streamSessionId();
      cell.dataset.transcodeJob = jobId;
      cell.dataset.hlsCancelled = '0';
      const query = new URLSearchParams({
        profile: S.streamProfile,
        start: streamOffset.toFixed(3),
        speed: String(plan.streamSpeed),
      });
      if (supportsNativeHls(v)) {
        query.set('recording_id', String(rec.id));
        cell.dataset.streamTransport = 'hls';
        cell.dataset.hlsJob = jobId;
        cell.dataset.hlsCancelled = '0';
        cell.dataset.pendingUrl = appUrl(`/hls/${jobId}/index.m3u8?${query}`);
      } else {
        cell.dataset.streamTransport = 'mp4';
        cell.dataset.hlsCancelled = '0';
        query.set('session_id', jobId);
        cell.dataset.pendingUrl = appUrl(`/stream/${rec.id}?${query}`);
      }
      loadCompressedSource(v, {session_id: jobId, recording_id: rec.id, profile: S.streamProfile,
        start: Number(streamOffset.toFixed(3)), speed: plan.streamSpeed, transport: cell.dataset.streamTransport}, cell.dataset.pendingUrl);
    } else {
      cell.dataset.streamTransport = 'native';
      cell.dataset.hlsCancelled = '0';
      v.src = appUrl(`/video/${rec.id}?v=${_nativeMediaCacheToken}`);
    }
    if (!plan.transcoded) v.load();
    const generation = v._generation;
    const expectedSource = plan.transcoded ? cell.dataset.pendingUrl : v.src;
    for (const event of ['onloadedmetadata', 'onloadeddata', 'oncanplay', 'onseeked', 'onplaying', 'onwaiting', 'onstalled', 'onerror', 'onended']) {
      const handler = v[event];
      v[event] = (...args) => {
        if (v._generation === generation && v.src === expectedSource &&
            (!v.currentSrc || v.currentSrc === expectedSource)) return handler?.(...args);
      };
    }
  } else {
    cell.dataset.recording = '';
    v.dataset.recording = '';
    cell.dataset.start = '';
    cell.dataset.streamOffset = '';
    cell.dataset.streamSpeed = '';
    cell.dataset.playbackRate = '';
    cell.dataset.duration = '';
    cell.dataset.profile = '';
    cell.dataset.streamTransport = '';
    cell.dataset.hlsCancelled = '0';
    cell.dataset.transitioning = '';
    cell.dataset.buffering = '0';
    cell.dataset.failed = '0';
    v.dataset.hasPlayed = '0';
    v.dataset.metadataReady = '0';
    v.dataset.driftSeek = '0';
    v.dataset.warming = '0';
    clearFreezeFrame(v);
    v.pause();
    v.onended = v.onloadedmetadata = v.onloadeddata = v.oncanplay = v.onseeked = null;
    v.onplaying = v.onwaiting = v.onstalled = v.onerror = null;
    v.removeAttribute('src');
    v.load();
    v.hidden = true;
    setPlayerStatus(cell, '');
    empty.textContent = t('player.noneAtTime');
    empty.hidden = false;
  }
}

function setPlayerStatus(cell, message, error = false) {
  const status = cell.querySelector('.player-status');
  if (!status) return;
  status.textContent = message;
  status.classList.toggle('error', error);
  status.hidden = !message;
  if (!error) cell.dataset.buffering = message ? '1' : '0';
}

function selectedFrameReady(video) {
  return !video.seeking && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
}

function clearStatusWhenReady(video) {
  if ((!S.playing && selectedFrameReady(video)) || (S.playing && videoHasPlaybackBuffer(video))) {
    setPlayerStatus(video.parentElement, '');
  }
}

function clearFreezeFrame(video) {
  const canvas = video.parentElement?.querySelector('.player-freeze');
  if (!canvas) return;
  canvas.dataset.token = String((Number(canvas.dataset.token) || 0) + 1);
  canvas.hidden = true;
}

function showFreezeFrame(video) {
  if (!selectedFrameReady(video) || !video.videoWidth || !video.videoHeight) return;
  const cell = video.parentElement;
  const canvas = cell.querySelector('.player-freeze');
  if (!canvas) return;
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(cell.clientWidth * scale));
  const height = Math.max(1, Math.round(cell.clientHeight * scale));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.fillStyle = '#0a0a0f';
  context.fillRect(0, 0, width, height);
  const fill = document.getElementById('player-area').classList.contains('fill');
  const ratio = fill
    ? Math.max(width / video.videoWidth, height / video.videoHeight)
    : Math.min(width / video.videoWidth, height / video.videoHeight);
  const drawWidth = video.videoWidth * ratio;
  const drawHeight = video.videoHeight * ratio;
  try {
    context.drawImage(video, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
    canvas.dataset.token = String((Number(canvas.dataset.token) || 0) + 1);
    canvas.hidden = false;
  } catch (_) {
    canvas.hidden = true;
  }
}

function revealFreezeOnNextFrame(video) {
  const canvas = video.parentElement?.querySelector('.player-freeze');
  if (!canvas || canvas.hidden) return;
  const token = canvas.dataset.token;
  const reveal = () => {
    if (canvas.dataset.token === token && video.dataset.warming !== '1') canvas.hidden = true;
  };
  if (typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(reveal);
  else setTimeout(reveal, 80);
}

function findRecordingAt(cameraId, ts) {
  if (!S.timeline || ts == null) return null;
  const cam = S.timeline.cameras.find(c => c.camera_id === cameraId);
  if (!cam) return null;
  const recording = CtvMedia.recordingAt(cam.segments, ts);
  if (!recording || S.streamProfile === 'native' || recording.end_ts == null) {
    return recording;
  }
  const plan = CtvMedia.playbackPlan(S.streamProfile, S.speed);
  const configuredFps = Number(S.streamProfiles?.[S.streamProfile]?.fps);
  const fallbackFps = S.streamProfile === 'balanced' ? 15 : 8;
  return CtvMedia.transcodedTailHasFrame(
    recording.end_ts - ts,
    plan.streamSpeed,
    configuredFps || fallbackFps,
  ) ? recording : null;
}

function syncAutoHotspotAtCurrentTime() {
  if (!S.autoHotspot || S.layoutMode !== 'hotspot' || !S.timeline || S.currentTime == null) return;
  const visibleIds = visibleCameras().map(camera => camera.id);
  const candidate = hotspotCurrentCandidate(S.timeline.cameras, visibleIds, S.currentTime);
  if (candidate != null && candidate !== S.hotspotOrder[0]) {
    promoteHotspotCamera(candidate, false);
  }
}

function updateAutoHotspot(previousTime, currentTime) {
  if (!S.autoHotspot || S.layoutMode !== 'hotspot' || !S.timeline || currentTime == null) return;
  const visibleIds = visibleCameras().map(camera => camera.id);
  const started = hotspotStartCandidate(S.timeline.cameras, visibleIds, previousTime, currentTime);
  if (started != null) {
    if (started !== S.hotspotOrder[0]) promoteHotspotCamera(started, false);
    return;
  }

  const primary = S.hotspotOrder[0];
  if (primary != null && findRecordingAt(primary, currentTime)) return;
  const fallback = hotspotCameras().find(camera => findRecordingAt(camera.id, currentTime));
  if (fallback && fallback.id !== primary) promoteHotspotCamera(fallback.id, false);
}

// ── Seek ──
function seekPlayersToTime() {
  resetPlaybackRecovery();
  if (S.streamProfile !== 'native') {
    renderPlayers(true);
    return;
  }
  let needsRender = false;
  displayedCameras().forEach(c => {
    const rec = findRecordingAt(c.id, S.currentTime);
    const cached = _playerCache[c.id];
    const newRecId = rec ? String(rec.id) : '';
    if (!cached || cached.recId !== newRecId) { needsRender = true; }
  });
  if (needsRender) {
    renderPlayers();
  } else {
    document.querySelectorAll('#player-area video').forEach(v => {
      const recStart = parseFloat(v.parentElement.dataset.start);
      if (S.currentTime != null && !isNaN(recStart)) {
        seekVideo(v);
      }
    });
  }
}

function seekCurrentTime() {
  if (S.currentTime != null) {
    renderPlayers(S.streamProfile !== 'native');
    updateCursor();
    updateTimeDisplay();
  }
}

// ── Video ended → move the single global clock past the segment boundary ──
function onVideoEnded(videoEl, expectedRecId = videoEl.dataset.recording) {
  const cell = videoEl.parentElement;
  const camId = parseInt(cell.dataset.cam);
  const curRecId = cell.dataset.recording;
  if (!camId || !S.timeline) return;
  if (!curRecId || curRecId !== String(expectedRecId)) return;
  if (videoEl.dataset.recording !== curRecId || cell.dataset.transitioning === curRecId) return;
  const cam = S.timeline.cameras.find(c => c.camera_id === camId);
  if (!cam) return;
  const ended = cam.segments.find(s => String(s.id) === curRecId);
  if (!ended) return;
  cell.dataset.transitioning = curRecId;
  videoEl.onended = videoEl.onwaiting = videoEl.onstalled = null;
  const boundary = ended.end_ts ?? (ended.start_ts + (ended.duration || 0));
  const previousTime = S.currentTime;
  S.currentTime = Math.max(S.currentTime || 0, boundary + 0.001);
  _clockStartTime = S.currentTime;
  _clockStartWall = performance.now();
  updateTimeDisplay(); updateCursor();
  updateAutoHotspot(previousTime, S.currentTime);
  reconcilePlaybackPosition();
}

// ── Playback ──
function getVideos() { return Array.from(document.querySelectorAll('#player-area video')); }

function activeVideos() {
  return getVideos().filter(video =>
    !video.hidden && Boolean(video.parentElement.dataset.recording) &&
    video.parentElement.dataset.failed !== '1'
  );
}

function bufferedAheadAt(video, current) {
  for (let i = 0; i < video.buffered.length; i++) {
    if (video.buffered.start(i) <= current + 0.05 && video.buffered.end(i) >= current) {
      return Math.max(0, video.buffered.end(i) - current);
    }
  }
  return 0;
}

function requiredBuffer(video, currentTime = video.currentTime) {
  const expectedDuration = parseFloat(video.parentElement.dataset.duration);
  // A transcoded stream already encodes the requested timeline speed. Buffer
  // demand depends on how quickly the browser consumes that stream, not on the
  // amount of source time represented by each encoded second.
  return CtvMedia.requiredPlaybackBuffer(
    videoPlaybackRate(video), currentTime, expectedDuration, _wasBuffering || !S.playing,
  );
}

function videoReachedEnd(video) {
  const expectedDuration = parseFloat(video.parentElement.dataset.duration);
  return CtvMedia.playbackCompleted({
    ended: video.ended,
    currentTime: video.currentTime,
    expectedDuration,
    metadataReady: video.dataset.metadataReady === '1',
    hasPlayed: video.dataset.hasPlayed === '1',
    buffering: _wasBuffering,
    warming: video.dataset.warming === '1',
  });
}

function videoHasPlaybackBuffer(video) {
  // Let the decoder consume the tail so the native `ended` event can fire.
  if (videoReachedEnd(video)) return true;
  const expectedDuration = parseFloat(video.parentElement.dataset.duration);
  const start = parseFloat(video.parentElement.dataset.start);
  const warmingTarget = video.dataset.warming === '1' && S.currentTime != null && Number.isFinite(start)
    ? videoTargetTime(video)
    : null;
  const bufferPosition = warmingTarget ?? video.currentTime;
  if (Number.isFinite(expectedDuration) && bufferPosition >= expectedDuration - 0.5) {
    return !video.seeking && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
  }
  if (warmingTarget != null) {
    return bufferedAheadAt(video, bufferPosition) >= requiredBuffer(video, bufferPosition);
  }
  return !video.seeking && video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA &&
    bufferedAheadAt(video, video.currentTime) >= requiredBuffer(video);
}

function absoluteVideoTime(video) {
  const cell = video.parentElement;
  const start = parseFloat(cell.dataset.start);
  if (!Number.isFinite(start)) return null;
  return CtvMedia.timelineTimeForMedia(
    video.currentTime,
    start,
    parseFloat(cell.dataset.streamOffset) || 0,
    parseFloat(cell.dataset.streamSpeed) || 1,
  );
}

function restartProgressiveVideo(video) {
  const attempts = (Number(video.dataset.recoveryAttempts) || 0) + 1;
  if (attempts > 3) { failPlayback(); return false; }
  video.dataset.recoveryAttempts = String(attempts);
  playbackDiagnostics.restarts++;
  const cell = video.parentElement;
  const cid = parseInt(cell.dataset.cam);
  const cam = S.cameras.find(camera => camera.id === cid);
  const rec = findRecordingAt(cid, S.currentTime);
  video.pause();
  updatePlayerCell(cell, cam, rec, cid);
  _playerCache[cid] = {
    recId: rec ? String(rec.id) : '',
    sourceKey: playerSourceKey(rec),
  };
  return true;
}

function enterBufferingBarrier(source, message) {
  if (source) {
    source.dataset.driftSeek = '0';
    setPlayerStatus(source.parentElement, message || t('player.buffering'));
  }
  if (!S.playing) return;
  // Repeated waiting events belong to the same recovery. In particular, do
  // not start playback again on a progressive stream already filling its buffer.
  const alreadyBuffering = _wasBuffering;
  if (!alreadyBuffering && _recoveryStarted == null) {
    _recoveryStarted = performance.now();
    playbackDiagnostics.recoveries++;
  }
  _wasBuffering = true;
  const videos = activeVideos();
  // S.currentTime is authoritative. A newly loaded video's currentTime is often
  // still zero here and must never be allowed to rewind the global clock.
  videos.forEach(video => {
    if ((alreadyBuffering && video.dataset.warming === '1') ||
        (video.parentElement.dataset.transcodeJob && !video.getAttribute('src'))) return;
    video.pause();
    if (!videoHasPlaybackBuffer(video)) {
      video.dataset.warming = '1';
      showFreezeFrame(video);
      video.preload = 'auto';
      video.playbackRate = videoPlaybackRate(video);
      // Established progressive streams continue downloading while paused.
      // HLS needs playback to refresh its playlist; a new source still needs
      // its initial play handshake. Real MP4 drift is handled by alignVideos.
      if (video.parentElement.dataset.streamTransport !== 'mp4' ||
          video.dataset.hasPlayed !== '1') {
        video.play().catch(() => {});
      }
    } else {
      video.dataset.warming = '0';
    }
  });
  _clockStartTime = S.currentTime;
  _clockStartWall = performance.now();
}

function alignVideos(videos) {
  let aligned = true;
  let restartedProgressiveStream = false;
  videos.forEach(video => {
    if (!S.playing) { aligned = false; return; }
    const cell = video.parentElement;
    const start = parseFloat(cell.dataset.start);
    if (!Number.isFinite(start) || S.currentTime == null) return;
    if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
      aligned = false;
      return;
    }
    const target = videoTargetTime(video);
    if (Math.abs(video.currentTime - target) > 0.1) {
      if (cell.dataset.streamTransport === 'mp4') {
        const duration = parseFloat(cell.dataset.duration);
        const remaining = Number.isFinite(duration) ? duration - target : Infinity;
        if (remaining <= 0.5) return;
        if (restartProgressiveVideo(video) === false) { aligned = false; return; }
        restartedProgressiveStream = true;
        aligned = false;
        return;
      }
      video.currentTime = target;
      setPlayerStatus(cell, t('player.buffering'));
      aligned = false;
    }
  });
  if (restartedProgressiveStream && S.playing) {
    _wasBuffering = false;
    enterBufferingBarrier(null, null);
  }
  return aligned;
}

function stopPlayback(immediate = false) {
  if (_tickId) { cancelAnimationFrame(_tickId); _tickId = null; }
  S.playing = false;
  _wasBuffering = false;
  finishRecovery();
  getVideos().forEach(v => {
    v.dataset.warming = '0';
    clearFreezeFrame(v);
    v.pause();
    v.preload = S.preloadMode;
    if (v.parentElement.dataset.transcodeJob) {
      if (immediate) { showFreezeFrame(v); cancelHlsSource(v); }
      else schedulePausedRelease(v);
    }
  });
  updatePlayButton();
}

document.getElementById('btn-play').onclick = () => {
  if (S.playing) { stopPlayback(); return; }
  resetPlaybackRecovery();
  getVideos().forEach(video => clearTimeout(video._pauseTimer));
  if (S.currentTime == null && S.timeline) {
    const firstSeg = S.timeline.cameras[0]?.segments[0];
    if (firstSeg) S.currentTime = firstSeg.start_ts;
    syncAutoHotspotAtCurrentTime(); renderPlayers(); updateCursor(); updateTimeDisplay();
  }
  if (S.currentTime == null) {
    toast(t('player.noneForDay'), 'error');
    return;
  }
  if (hasCancelledHlsSources()) renderPlayers(true);
  S.playing = true; updatePlayButton();
  if (typeof selectedEventTypes !== 'undefined' && selectedEventTypes.size) {
    reconcilePlaybackPosition();
    if (!S.playing) return;
  }
  enterBufferingBarrier(null, null);
  startClock();
};

function reloadPlaybackStreams() {
  resetPlaybackRecovery();
  const wasPlaying = S.playing;
  if (_tickId) { cancelAnimationFrame(_tickId); _tickId = null; }
  _wasBuffering = false;
  getVideos().forEach(video => video.pause());
  renderPlayers(true);
  if (wasPlaying) {
    enterBufferingBarrier(null, null);
    startClock();
  }
}

function applyPlaybackSpeed(value) {
  const speed = parseFloat(value);
  if (!Number.isFinite(speed) || speed <= 0 || speed === S.speed) return;
  S.speed = speed;
  _clockStartTime = S.currentTime;
  _clockStartWall = performance.now();
  if (S.streamProfile === 'native') {
    getVideos().forEach(video => {
      video.parentElement.dataset.playbackRate = String(S.speed);
      video.playbackRate = S.speed;
    });
  } else {
    reloadPlaybackStreams();
  }
}

const speedSelect = document.getElementById('speed-select');
speedSelect.addEventListener('input', () => applyPlaybackSpeed(speedSelect.value));
speedSelect.addEventListener('change', () => applyPlaybackSpeed(speedSelect.value));

document.getElementById('quality-select').onchange = function() {
  S.streamProfile = this.value;
  localStorage.setItem('ctv-stream-profile', S.streamProfile);
  reloadPlaybackStreams();
};

document.getElementById('preload-select').onchange = function() {
  S.preloadMode = this.value === 'auto' ? 'auto' : 'metadata';
  localStorage.setItem('ctv-preload-mode', S.preloadMode);
  reloadPlaybackStreams();
};

window.addEventListener('pagehide', () => {
  stopPlayback(true);
});

document.addEventListener('visibilitychange', () => { if (document.hidden) stopPlayback(true); });
document.getElementById('playback-retry').onclick = () => document.getElementById('btn-play').click();

window.addEventListener('pageshow', event => {
  if (event.persisted) updatePlayButton();
});

function updatePlayButton() {
  const button = document.getElementById('btn-play');
  button.textContent = S.playing ? '⏸' : '▶';
  button.setAttribute('aria-label', S.playing ? t('controls.pause') : t('controls.play'));
}
function updateTimeDisplay() {
  const display = document.getElementById('time-display');
  const value = S.currentTime ? fmtTime(S.currentTime) : '--';
  if (display.textContent !== value) display.textContent = value;
  updateEventOverlays();
}
function updatePlaybackUi(force = false) {
  const now = performance.now();
  const interval = isCompactViewport() ? 50 : 33;
  if (!force && now - _lastPlaybackUiUpdate < interval) return;
  _lastPlaybackUiUpdate = now;
  updateTimeDisplay();
  updateCursor();
}

// ── Global clock ──
function startClock() {
  if (_tickId) cancelAnimationFrame(_tickId);
  _clockStartTime = S.currentTime;
  _clockStartWall = performance.now();
  updatePlaybackUi(true);
  clockTick();
}

function clockTick() {
  if (!S.playing || S.activeTab !== 'timeline') { _tickId = null; return; }
  if (_recoveryStarted != null && performance.now() - _recoveryStarted > 30000) {
    failPlayback(); return;
  }
  const videos = activeVideos();
  const completed = _wasBuffering ? null : videos.find(videoReachedEnd);
  if (completed) {
    onVideoEnded(completed, completed.dataset.recording);
    _tickId = requestAnimationFrame(clockTick);
    return;
  }
  const bufferStates = videos.map(video => ({
    video,
    ready: videoHasPlaybackBuffer(video),
  }));
  bufferStates.forEach(({ video, ready }) => {
    if (video.parentElement.dataset.buffering === '1' && ready) {
      setPlayerStatus(video.parentElement, '');
    }
  });
  const buffering = bufferStates.some(({ video, ready }) =>
    video.parentElement.dataset.buffering === '1' ||
    (video.dataset.driftSeek !== '1' && !ready)
  );
  if (buffering) {
    if (!_wasBuffering) enterBufferingBarrier(null, null);
    _clockStartTime = S.currentTime;
    _clockStartWall = performance.now();
    _tickId = requestAnimationFrame(clockTick);
    return;
  }
  if (_wasBuffering) {
    if (!alignVideos(videos) || videos.some(video => !videoHasPlaybackBuffer(video))) {
      _tickId = requestAnimationFrame(clockTick);
      return;
    }
    _wasBuffering = false;
    finishRecovery();
    videos.forEach(video => {
      video.dataset.warming = '0';
      setPlayerStatus(video.parentElement, '');
      video.playbackRate = videoPlaybackRate(video);
      revealFreezeOnNextFrame(video);
      const generation = video._generation, epoch = _playbackEpoch;
      video.play().catch(() => {
        if (S.playing && generation === video._generation && epoch === _playbackEpoch) {
          enterBufferingBarrier(video, t('player.buffering'));
        }
      });
    });
    _clockStartTime = S.currentTime;
    _clockStartWall = performance.now();
  }

  const previousTime = S.currentTime;
  const timedVideos = videos
    .map(video => ({ video, time: absoluteVideoTime(video) }))
    .filter(item => Number.isFinite(item.time));
  if (timedVideos.length) {
    const videoTimes = timedVideos.map(item => item.time);
    const synchronizedTime = CtvMedia.medianTime(videoTimes);
    const maxSpread = S.speed >= 8 ? 0.5 : 0.25;
    const spread = Math.max(...videoTimes) - Math.min(...videoTimes);
    if (spread > maxSpread) {
      const outlier = timedVideos.reduce((worst, item) => {
        const deviation = Math.abs(item.time - synchronizedTime);
        return !worst || deviation > worst.deviation ? { video: item.video, deviation } : worst;
      }, null).video;
      enterBufferingBarrier(outlier, t('player.buffering'));
      _tickId = requestAnimationFrame(clockTick);
      return;
    }
    S.currentTime = synchronizedTime;
    _clockStartTime = S.currentTime;
    _clockStartWall = performance.now();
  } else {
    const elapsed = (performance.now() - _clockStartWall) / 1000 * S.speed;
    S.currentTime = _clockStartTime + elapsed;
  }

  updatePlaybackUi();
  updateAutoHotspot(previousTime, S.currentTime);

  // Auto-scroll
  if (S.zoomRange && S.timeline) {
    const [vFrom, vTo] = S.zoomRange;
    const range = vTo - vFrom;
    if (S.currentTime > vTo - range * 0.15 && vTo < S.timeline.to) {
      const shift = range * 0.35;
      let nf = vFrom + shift, nt = vTo + shift;
      if (nt > S.timeline.to) { nt = S.timeline.to; nf = nt - range; }
      if (nf < S.timeline.from) nf = S.timeline.from;
      if (nt > nf) { S.zoomRange = [nf, nt]; renderTimeline(); }
    }
  }

  reconcilePlaybackPosition();
  _tickId = requestAnimationFrame(clockTick);
}

function reconcilePlaybackPosition() {
  if (!S.timeline || S.currentTime == null) return;
  const displayed = displayedCameras();
  if (!displayed.length) { stopPlayback(); return; }

  let anyHasRecording = displayed.some(c => findRecordingAt(c.id, S.currentTime));
  if (!anyHasRecording) {
    const displayedIds = new Set(displayed.map(c => c.id));
    let nextStart = Infinity;
    S.timeline.cameras.forEach(cam => {
      if (!displayedIds.has(cam.camera_id)) return;
      cam.segments.forEach(segment => {
        if (segment.start_ts > S.currentTime && segment.start_ts < nextStart) {
          nextStart = segment.start_ts;
        }
      });
    });
    if (nextStart === Infinity) { stopPlayback(); return; }
    const previousTime = S.currentTime;
    S.currentTime = nextStart + 0.001;
    _clockStartTime = S.currentTime;
    _clockStartWall = performance.now();
    ensureTimelineTimeVisible(S.currentTime, 0.2);
    updateTimeDisplay(); updateCursor();
    updateAutoHotspot(previousTime, S.currentTime);
  }

  const transitions = displayed.map(c => {
    const rec = findRecordingAt(c.id, S.currentTime);
    const cachedId = _playerCache[c.id]?.recId ?? null;
    return { cachedId, nextId: rec ? String(rec.id) : '' };
  });
  const needsRender = transitions.some(({ cachedId, nextId }) => cachedId !== nextId);
  const requiresWarmup = transitions.some(({ cachedId, nextId }) =>
    Boolean(nextId) && cachedId !== nextId
  );
  if (needsRender) {
    renderPlayers();
    // Removing an ended camera must not pause streams that continue across the
    // boundary. A new recording will enter the shared barrier as usual.
    if (S.playing && requiresWarmup) enterBufferingBarrier(null, null);
  }
}


function updateEventOverlays() {
  if (!window.CtvEventPlayback) return;
  document.querySelectorAll('#player-area .player-cell').forEach(cell => {
    const cid = Number(cell.dataset.cam);
    const video = cell.querySelector('video');
    const camera = S.cameras.find(item => item.id === cid);
    const time = video && !video.hidden && video.readyState >= 2 && video.dataset.warming !== '1'
      ? absoluteVideoTime(video) : null;
    const recording = time == null ? null : findRecordingAt(cid, time);
    const active = recording ? CtvEventPlayback.activeTypes(recording.events, time) : [];
    let overlay = cell.querySelector('.video-event-badges');
    if (!overlay && !active.length) return;
    if (!overlay) { overlay = document.createElement('div'); overlay.className = 'video-event-badges'; cell.appendChild(overlay); }
    overlay.dataset.position = camera?.event_overlay_position || 'top-right';
    // Anchor to the displayed image, not to the surrounding letterbox bars.
    const width = video?.clientWidth || cell.clientWidth;
    const height = video?.clientHeight || cell.clientHeight;
    const geometry = [width,height,video?.videoWidth,video?.videoHeight,cell.clientWidth,cell.clientHeight,overlay.dataset.position].join(':');
    if (overlay.dataset.geometry !== geometry && video?.videoWidth && video?.videoHeight) {
      overlay.dataset.geometry = geometry;
      const scale = Math.min(width/video.videoWidth, height/video.videoHeight);
      const imageWidth = video.videoWidth*scale, imageHeight = video.videoHeight*scale;
      const x = video.offsetLeft+(width-imageWidth)/2, y = video.offsetTop+(height-imageHeight)/2;
      const [vertical,horizontal] = overlay.dataset.position.split('-');
      overlay.style.top = vertical === 'top' ? `${Math.max(30,y+8)}px` : 'auto';
      overlay.style.bottom = vertical === 'bottom' ? `${Math.max(8,cell.clientHeight-y-imageHeight+8)}px` : 'auto';
      overlay.style.left = horizontal === 'left' ? `${x+8}px` : horizontal === 'center' ? `${x+imageWidth/2}px` : 'auto';
      overlay.style.right = horizontal === 'right' ? `${Math.max(8,cell.clientWidth-x-imageWidth+8)}px` : 'auto';
      overlay.style.maxWidth = `${Math.max(24,imageWidth-16)}px`;
    }
    const key = active.map(kind => t('events.'+kind)).join('|');
    if (overlay.dataset.active !== key) {
      overlay.dataset.active = key;
      overlay.innerHTML = active.map(kind => `<span class="video-event-badge" title="${escAttr(t('events.'+kind))}">${CtvEventIcons.svg(kind)}<span>${esc(t('events.'+kind))}</span></span>`).join('');
    }
    overlay.hidden = !active.length;
  });
}
