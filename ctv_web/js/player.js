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
const _failedRecordings = new Map();
const MEDIA_ALIGNMENT_TOLERANCE = 0.1;
const playbackClockTrace = {tick: null, phase: 'idle'};
window.ctvPlaybackState = () => ({
  playing: S.playing, time: S.currentTime, speed: S.speed, profile: S.streamProfile,
  tab: S.activeTab, buffering: _wasBuffering,
  recoveryAgeMs: _recoveryStarted == null ? null : performance.now() - _recoveryStarted,
  tickAgeMs: playbackClockTrace.tick == null ? null : performance.now() - playbackClockTrace.tick,
  phase: playbackClockTrace.phase,
});

function hasCompressedPlayback() {
  return S.streamProfile !== 'native' || getVideos().some(video =>
    ['mp4', 'hls'].includes(video.parentElement.dataset.streamTransport));
}

function playerSourceKey(rec) {
  if (!rec) return '';
  const profile = S.streamProfile;
  const plan = CtvMedia.playbackPlan(profile, S.speed);
  return `${rec.id}:${profile}:${plan.streamSpeed}:${S.streamProfileRevision}`;
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
    // Native files have a final browser duration. Never seek into an indexed
    // tail that does not exist: recovery would retry that impossible target.
    // Progressive/HLS durations may still grow, so retain their source target.
    cell.dataset.streamTransport === 'native' ? videoBufferDuration(video) : parseFloat(cell.dataset.duration),
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

function pauseVideo(video) {
  // pause() rejects a pending play in a later microtask. Invalidate that
  // attempt before pausing, even when the source and playback epoch survive.
  video._playAttempt = (video._playAttempt || 0) + 1;
  video.pause();
}

function playVideo(video, recoverOnFailure = false) {
  const generation = video._generation, epoch = _playbackEpoch;
  const attempt = video._playAttempt = (video._playAttempt || 0) + 1;
  return video.play().catch(error => {
    window.ctvTracePlayRejected?.(video, error);
    if (!S.playing || generation !== video._generation || epoch !== _playbackEpoch ||
        attempt !== video._playAttempt) return;
    if (error.name === 'NotAllowedError') {
      // This is a browser policy denial, not insufficient media data. A fresh
      // user gesture is required; entering ready-buffer recovery would loop.
      stopPlayback();
      document.getElementById('playback-notice-text').textContent = t('player.playbackBlocked');
      document.getElementById('playback-notice').hidden = false;
    } else if (recoverOnFailure) {
      enterBufferingBarrier(video, t('player.buffering'));
    }
  });
}

function cancelHlsSource(video) {
  if (!video) return;
  clearTimeout(video._pauseTimer);
  video._generation = (video._generation || 0) + 1;
  const jobId = video.parentElement?.dataset.transcodeJob || video.parentElement?.dataset.hlsJob;
  pauseVideo(video);
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
  _wasBuffering = false;
  finishRecovery();
  getVideos().forEach(video => {
    video.dataset.recoveryAttempts = '0';
    video._nativeRecoveryReload = null;
  });
  document.getElementById('playback-notice').hidden = true;
}

function finishRecovery() {
  if (_recoveryStarted != null) {
    const durationMs = performance.now() - _recoveryStarted;
    playbackDiagnostics.bufferingMs += durationMs;
    window.ctvTraceAction?.('buffering-finished', {durationMs});
  }
  _recoveryStarted = null;
}

function failVideo(video, code = 'unplayable') {
  const cell = video.parentElement;
  const recording = cell.dataset.recording;
  if (!recording) return;
  const known = ['capacity', 'storage_limit', 'encoding', 'recoveryFailed', 'session_expired'];
  const reason = known.includes(code) ? code : 'unplayable';
  window.ctvTraceAction?.('recording-failed', {camera:cell.dataset.cam, recording, reason,
    video:window.ctvTraceEnabled?.() ? window.CtvPlaybackTrace?.videoState(video) : undefined});
  _failedRecordings.set(recording, reason);
  cancelHlsSource(video);
  cell.dataset.failed = '1';
  cell.dataset.buffering = '0';
  video.dataset.warming = '0';
  video.hidden = true;
  clearFreezeFrame(video);
  cell.querySelector('.empty-state').hidden = true;
  setPlayerStatus(cell, t(`player.${reason}`), true);
  // Keep the indexed recording interval. With no playable camera, the global
  // clock advances through it using wall time and selects the next recording.
  _clockStartTime = S.currentTime;
  _clockStartWall = performance.now();
  updateEventOverlays();
}

function retryFailedRecordings() {
  _failedRecordings.clear();
  getVideos().forEach(video => {
    if (video.parentElement.dataset.failed === '1') {
      _playerCache[video.parentElement.dataset.cam] = null;
    }
  });
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
      if (generation === video._generation) failVideo(video, body.detail);
      return;
    }
    video.src = url;
    video.dataset.warming = '0';
    video.load();
    if (S.playing) enterBufferingBarrier(null, null);
    else schedulePausedRelease(video);
  } catch (_) {
    if (generation === video._generation) failVideo(video);
  }
}

function hasCancelledHlsSources() {
  return getVideos().some(video => video.parentElement.dataset.hlsCancelled === '1');
}

function seekVideo(video) {
  if (video.parentElement.dataset.failed === '1') return false;
  if (S.currentTime == null || video.readyState < HTMLMediaElement.HAVE_METADATA) return false;
  // Wait for the decoder to finish before issuing another Range-producing
  // seek. Repeated alignment while seeking can cancel every pending download.
  if (video.seeking) return false;
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
    if (v.dataset.recording !== recId) v.dataset.recoveryAttempts = '0';
    const originalDuration = rec.duration ??
      Math.max(0, (rec.end_ts ?? rec.start_ts) - rec.start_ts);
    const profile = S.streamProfile;
    const plan = CtvMedia.playbackPlan(profile, S.speed);
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
    cell.dataset.profile = profile;
    cell.dataset.streamTransport = '';
    cell.dataset.transitioning = '';
    cell.dataset.buffering = '1';
    cell.dataset.failed = '0';
    if (_failedRecordings.has(recId)) {
      failVideo(v, _failedRecordings.get(recId));
      return;
    }
    v.dataset.hasPlayed = '0';
    v.dataset.metadataReady = '0';
    v.dataset.driftSeek = '0';
    v.dataset.warming = '0';
    v._endProgress = null;
    clearFreezeFrame(v);
    empty.hidden = true;
    v.hidden = false;
    setPlayerStatus(cell, t('player.loading'));
    pauseVideo(v);
    v.playbackRate = plan.playbackRate;
    v.loop = false;
    v.onended = () => {
      if (v.dataset.metadataReady !== '1' || v.dataset.hasPlayed !== '1') return;
      if (videoReachedEnd(v)) {
        onVideoEnded(v, recId);
        return;
      }
      if (_wasBuffering || v.dataset.warming === '1') {
        if (cell.dataset.streamTransport === 'mp4' && v.ended) {
          onVideoEnded(v, recId);
          return;
        }
        pauseVideo(v);
        seekVideo(v);
        return;
      }
      enterBufferingBarrier(v, t('player.buffering'));
      playVideo(v);
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
        // HLS refreshes its playlist through playback. Mobile native media
        // may stop prefetching while paused; warm it at 1x behind the freeze.
        // Progressive MP4 stays at its URL's zero-time anchor.
        if (!keepVideoWarming(v)) pauseVideo(v);
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
    v.onerror = () => {
      const mediaError = v.error;
      console.error('CTV media failure', {recording: recId, transport: cell.dataset.streamTransport,
        code: mediaError?.code, message: mediaError?.message, source: v.currentSrc || v.src});
      failVideo(v);
    };
    // This is a per-browser preference because preload behavior varies by
    // engine and connection. Browsers may still treat it as a hint.
    v.preload = S.preloadMode;
    if (plan.transcoded) {
      const jobId = streamSessionId();
      cell.dataset.transcodeJob = jobId;
      cell.dataset.hlsCancelled = '0';
      const query = new URLSearchParams({
        profile,
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
      loadCompressedSource(v, {session_id: jobId, recording_id: rec.id, profile,
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
    pauseVideo(v);
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
  if (video.parentElement.dataset.failed === '1') return;
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
  if (recording && _failedRecordings.has(String(recording.id))) {
    // A failed compressed file still owns its entire indexed interval, even
    // the short tail for which no transcoded frame could otherwise be emitted.
    if (recording.end_ts == null && Number.isFinite(S.timeline.to) && ts >= S.timeline.to) return null;
    return recording;
  }
  const profile = S.streamProfile;
  if (!recording || profile === 'native' || recording.end_ts == null) {
    return recording;
  }
  const plan = CtvMedia.playbackPlan(profile, S.speed);
  const configuredFps = Number(S.streamProfiles?.[profile]?.fps);
  const fallbackFps = profile === 'balanced' ? 15 : 8;
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
  window.ctvTraceAction?.('seek', {time:S.currentTime});
  resetPlaybackRecovery();
  if (hasCompressedPlayback()) {
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
    renderPlayers(hasCompressedPlayback());
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
  window.ctvTraceAction?.('recording-end', {camera:videoEl.parentElement?.dataset.cam, recording:expectedRecId});
  // A duration-less record would otherwise remain active forever after ended.
  if (!Number.isFinite(ended.end_ts) || ended.end_ts <= ended.start_ts) {
    const measuredEnd = absoluteVideoTime(videoEl);
    if (!Number.isFinite(measuredEnd) || measuredEnd <= ended.start_ts) return;
    for (const timeline of new Set([S.timeline, S.unfilteredTimeline])) {
      const camera = timeline?.cameras.find(c => c.camera_id === camId);
      if (camera) camera.segments = camera.segments.map(segment =>
        String(segment.id) === curRecId ? {...segment, end_ts: measuredEnd} : segment);
    }
    ended.end_ts = measuredEnd;
  }
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

function bufferCoversNativeTail(video, duration) {
  for (let i = 0; i < video.buffered.length; i++) {
    if (video.buffered.start(i) <= video.currentTime &&
        video.buffered.end(i) >= video.currentTime - 0.002 &&
        video.buffered.end(i) >= duration - 0.002) return true;
  }
  return false;
}

function videoBufferDuration(video) {
  const expected = parseFloat(video.parentElement.dataset.duration);
  const actual = video.duration;
  if (!Number.isFinite(actual) || actual <= 0) return expected;
  return Number.isFinite(expected) && expected > 0 ? Math.min(expected, actual) : actual;
}

function requiredBuffer(video, currentTime = video.currentTime) {
  const expectedDuration = videoBufferDuration(video);
  // A transcoded stream already encodes the requested timeline speed. Buffer
  // demand depends on how quickly the browser consumes that stream, not on the
  // amount of source time represented by each encoded second.
  return CtvMedia.requiredPlaybackBuffer(
    videoPlaybackRate(video), currentTime, expectedDuration, _wasBuffering || !S.playing,
  );
}

function videoReachedEnd(video) {
  const expectedDuration = parseFloat(video.parentElement.dataset.duration);
  const completed = CtvMedia.playbackCompleted({
    ended: video.ended,
    currentTime: video.currentTime,
    actualDuration: video.duration,
    expectedDuration,
    metadataReady: video.dataset.metadataReady === '1',
    hasPlayed: video.dataset.hasPlayed === '1',
    buffering: _wasBuffering,
    warming: video.dataset.warming === '1',
  });
  if (completed) return true;
  if (!S.playing || video.seeking || video.dataset.metadataReady !== '1' ||
      video.dataset.hasPlayed !== '1') {
    video._endProgress = null;
    return false;
  }
  // Some decoders stop on the final frame without emitting ended. Observe
  // actual media progress, rather than letting a frozen global clock wait
  // forever for that event. Never infer EOF from the indexed duration alone.
  const now = performance.now();
  const duration = video.duration;
  const bufferedEnd = video.buffered.length
    ? video.buffered.end(video.buffered.length - 1) : null;
  const progress = video._endProgress;
  const key = `${video._generation}:${video.dataset.recording}`;
  if (!progress || progress.key !== key || Math.abs(video.currentTime - progress.time) > 0.001 ||
      !Object.is(duration, progress.duration) || bufferedEnd !== progress.bufferedEnd) {
    video._endProgress = {key, time: video.currentTime, duration, bufferedEnd, since: now};
    return false;
  }
  // WebKit may keep NETWORK_LOADING at a fully buffered Native tail without
  // any next video frame or ended event. Require a contiguous measured tail,
  // no future decoder data, and stable duration/buffer/media progress. A partial
  // download, growing file or unfinished HLS playlist is not evidence of EOF.
  const nativeTail = video.parentElement.dataset.streamTransport === 'native' &&
    video.readyState === HTMLMediaElement.HAVE_CURRENT_DATA &&
    Number.isFinite(duration) && duration > 0 &&
    video.currentTime >= duration - 0.5 && video.currentTime <= duration &&
    bufferCoversNativeTail(video, duration);
  return S.playing && video.dataset.metadataReady === '1' &&
    video.dataset.hasPlayed === '1' && !video.seeking &&
    (nativeTail || video.networkState === 1) &&
    Number.isFinite(duration) && duration > 0 &&
    (video.parentElement.dataset.streamTransport !== 'hls' ||
      (Number.isFinite(expectedDuration) && duration >= expectedDuration - 0.08)) &&
    (nativeTail || video.currentTime >= duration - 0.08) &&
    video.currentTime <= duration + 0.08 &&
    video.buffered.length > 0 &&
    video.buffered.end(video.buffered.length - 1) >= duration - 0.08 &&
    now - progress.since >= 1500;
}

function videoHasPlaybackBuffer(video) {
  // Let the decoder consume the tail so the native `ended` event can fire.
  if (videoReachedEnd(video)) return true;
  const expectedDuration = videoBufferDuration(video);
  const start = parseFloat(video.parentElement.dataset.start);
  const warmingTarget = video.dataset.warming === '1' && S.currentTime != null && Number.isFinite(start)
    ? videoTargetTime(video)
    : null;
  const bufferPosition = warmingTarget ?? video.currentTime;
  if (Number.isFinite(expectedDuration) && bufferPosition >= expectedDuration - 0.5) {
    // A retained Native frame cannot resume playback: accepting readyState=2
    // here creates Play/waiting/pause on every tick and renews recovery forever.
    const minimum = video.parentElement.dataset.streamTransport === 'native'
      ? HTMLMediaElement.HAVE_FUTURE_DATA : HTMLMediaElement.HAVE_CURRENT_DATA;
    return !video.seeking && video.readyState >= minimum;
  }
  if (warmingTarget != null) {
    return !video.seeking && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      bufferedAheadAt(video, bufferPosition) >= requiredBuffer(video, bufferPosition);
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

function playbackSpreadLimit(videos) {
  // alignVideos accepts +/- 100ms in encoded media time. At 16x encoded
  // speed that is +/- 1.6s on the timeline. A stricter spread threshold would
  // re-enter the barrier immediately after accepting the same alignment,
  // endlessly pausing healthy decoders and renewing the recovery deadline.
  const encodedSpeed = Math.max(1, ...videos.map(video =>
    Number(video.parentElement.dataset.streamSpeed) || 1));
  return Math.max(S.speed >= 8 ? 0.5 : 0.25,
    2 * MEDIA_ALIGNMENT_TOLERANCE * encodedSpeed);
}

function restartProgressiveVideo(video) {
  const attempts = (Number(video.dataset.recoveryAttempts) || 0) + 1;
  if (attempts > 3) { failVideo(video, 'recoveryFailed'); return false; }
  video.dataset.recoveryAttempts = String(attempts);
  playbackDiagnostics.restarts++;
  const cell = video.parentElement;
  const cid = parseInt(cell.dataset.cam);
  const cam = S.cameras.find(camera => camera.id === cid);
  const rec = findRecordingAt(cid, S.currentTime);
  pauseVideo(video);
  updatePlayerCell(cell, cam, rec, cid);
  _playerCache[cid] = {
    recId: rec ? String(rec.id) : '',
    sourceKey: playerSourceKey(rec),
  };
  return true;
}

function keepVideoWarming(video) {
  return video.dataset.warming === '1' &&
    ['native', 'hls'].includes(video.parentElement.dataset.streamTransport);
}

function nativeRecoveryTargetReady(video) {
  if (video.seeking || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return false;
  const target = videoTargetTime(video);
  const duration = videoBufferDuration(video);
  if (Number.isFinite(duration) && target >= duration - 0.5) {
    return video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA || videoReachedEnd(video);
  }
  return bufferedAheadAt(video, target) >= requiredBuffer(video, target);
}

function recoveryVideoFailed(video) {
  const cell = video.parentElement;
  // A Native tile with the requested data available needs alignment, even if
  // another tile held the barrier long enough for its media time to drift.
  if (cell.dataset.streamTransport === 'native' && nativeRecoveryTargetReady(video)) return false;
  if (!videoHasPlaybackBuffer(video)) return true;
  if (cell.dataset.streamTransport === 'mp4' &&
      Number(cell.dataset.duration) - videoTargetTime(video) <= 0.5) return false;
  return Math.abs(video.currentTime - videoTargetTime(video)) > MEDIA_ALIGNMENT_TOLERANCE;
}

function reloadNativeRecovery(video, target) {
  const cell = video.parentElement;
  const key = `${_playbackEpoch}:${video.dataset.recording}:${target}`;
  if (video._nativeRecoveryReload === key) return false;
  const cid = Number(cell.dataset.cam);
  const cam = S.cameras.find(item => item.id === cid);
  const rec = findRecordingAt(cid, S.currentTime);
  if (!cam || !rec || String(rec.id) !== video.dataset.recording) return false;
  video._nativeRecoveryReload = key;
  window.ctvTraceAction?.('native-recovery-reload', {
    camera:String(cid), recording:String(rec.id), target, mediaTime:video.currentTime,
    bufferedStart:video.buffered.length ? video.buffered.start(0) : null,
  });
  // Reinstall source-generation guards through the normal loader. The global
  // clock and the original recovery deadline remain authoritative.
  updatePlayerCell(cell, cam, rec, cid);
  video.dataset.warming = '1';
  video.preload = 'auto';
  video.playbackRate = 1;
  video._nativeRecoverySeek = null;
  return true;
}

function warmNativeBuffer(video) {
  if (!S.playing || !_wasBuffering ||
      video.parentElement.dataset.streamTransport !== 'native' || video.seeking) return;
  // Once its target is buffered, hold and align this decoder independently of
  // the other tiles. Continuing 1x warming can evict the very target we need.
  if (nativeRecoveryTargetReady(video)) {
    if (!video.paused) pauseVideo(video);
    seekVideo(video);
    return;
  }
  if (video.dataset.warming !== '1') {
    video.dataset.warming = '1';
    video._nativeRecoverySeek = null;
    video.preload = 'auto';
    showFreezeFrame(video);
  }
  const target = videoTargetTime(video);
  const seekKey = `${video._generation}:${target}`;
  if (video._nativeRecoverySeek === seekKey &&
      bufferedAheadAt(video, target) === 0 &&
      video.currentTime > target + MEDIA_ALIGNMENT_TOLERANCE &&
      reloadNativeRecovery(video, target)) return;
  // A paused decoder can retain its last frame after the browser evicts that
  // position. Downloading forward cannot refill a hole behind the buffer.
  // Request the target once per recovery, even when currentTime already equals
  // it; repeatedly assigning it would abort the browser's pending Range reads.
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA && video.buffered.length &&
      bufferedAheadAt(video, target) === 0 && video._nativeRecoverySeek !== seekKey) {
    video._nativeRecoverySeek = seekKey;
    video.currentTime = target;
  }
  video.playbackRate = 1;
  if (video.paused) playVideo(video);
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
  if (_recoveryStarted == null) {
    _recoveryStarted = performance.now();
    playbackDiagnostics.recoveries++;
    window.ctvTraceAction?.('buffering-start', {time:S.currentTime});
  }
  _wasBuffering = true;
  const videos = activeVideos();
  // S.currentTime is authoritative. A newly loaded video's currentTime is often
  // still zero here and must never be allowed to rewind the global clock.
  videos.forEach(video => {
    if ((alreadyBuffering && video.dataset.warming === '1') ||
        (video.parentElement.dataset.transcodeJob && !video.getAttribute('src'))) return;
    pauseVideo(video);
    if (!alreadyBuffering) video._nativeRecoverySeek = null;
    if (!videoHasPlaybackBuffer(video)) {
      video.dataset.warming = '1';
      showFreezeFrame(video);
      video.preload = 'auto';
      video.playbackRate = video.parentElement.dataset.streamTransport === 'native'
        ? 1 : videoPlaybackRate(video);
      // Established progressive streams continue downloading while paused.
      // HLS needs playback to refresh its playlist; a new source still needs
      // its initial play handshake. Real MP4 drift is handled by alignVideos.
      if (video.parentElement.dataset.streamTransport !== 'mp4' ||
          video.dataset.hasPlayed !== '1') {
        playVideo(video);
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
    if (video.seeking) {
      aligned = false;
      return;
    }
    const target = videoTargetTime(video);
    if (Math.abs(video.currentTime - target) > MEDIA_ALIGNMENT_TOLERANCE) {
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
  window.ctvTraceAction?.('playback-stop', {immediate});
  playbackClockTrace.phase = 'stopped';
  if (_tickId) { cancelAnimationFrame(_tickId); _tickId = null; }
  S.playing = false;
  _wasBuffering = false;
  finishRecovery();
  getVideos().forEach(v => {
    v.dataset.warming = '0';
    clearFreezeFrame(v);
    pauseVideo(v);
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
  const hadFailedVideos = getVideos().some(video => video.parentElement.dataset.failed === '1');
  retryFailedRecordings();
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
  else if (hadFailedVideos) renderPlayers();
  S.playing = true; updatePlayButton();
  window.ctvTraceAction?.('playback-start', {time:S.currentTime,speed:S.speed});
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
  getVideos().forEach(pauseVideo);
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
  if (!hasCompressedPlayback()) {
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
  retryFailedRecordings();
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
  playbackClockTrace.phase = 'starting';
  if (_tickId) cancelAnimationFrame(_tickId);
  _clockStartTime = S.currentTime;
  _clockStartWall = performance.now();
  updatePlaybackUi(true);
  clockTick();
}

function checkVideoProgress(video) {
  const now = performance.now();
  const key = `${video._generation}:${video.dataset.recording}:${video.getAttribute('src')}`;
  const progress = video._playbackProgress;
  if (!S.playing || _wasBuffering || video.seeking ||
      video.dataset.hasPlayed !== '1' || !videoHasPlaybackBuffer(video)) {
    video._playbackProgress = null;
    return;
  }
  if (!progress || progress.key !== key || Math.abs(video.currentTime - progress.time) > 0.001) {
    video._playbackProgress = {key, time: video.currentTime, since: now};
    return;
  }
  // A mobile decoder can freeze with readyState/buffered still reporting ready
  // and emit neither waiting nor error. Such a tile must not freeze the clock.
  if (now - progress.since >= 8000 && !videoReachedEnd(video)) {
    failVideo(video, 'recoveryFailed');
  }
}

function clockTick() {
  playbackClockTrace.tick = performance.now();
  playbackClockTrace.phase = 'progress';
  if (!S.playing || S.activeTab !== 'timeline') {
    playbackClockTrace.phase = 'stopped';
    _tickId = null; return;
  }
  activeVideos().forEach(checkVideoProgress);
  if (_recoveryStarted != null && performance.now() - _recoveryStarted > 30000) {
    activeVideos().filter(recoveryVideoFailed).forEach(video => failVideo(video, 'recoveryFailed'));
    finishRecovery();
    // Surviving tiles may still need the seek back to their buffered target.
    // Give that alignment its own recovery, rather than leaving no deadline.
    if (activeVideos().length) enterBufferingBarrier(null, null);
  }
  const videos = activeVideos();
  const completed = videos.find(videoReachedEnd);
  if (completed) {
    onVideoEnded(completed, completed.dataset.recording);
    _tickId = requestAnimationFrame(clockTick);
    return;
  }
  if (_wasBuffering) videos.forEach(warmNativeBuffer);
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
    playbackClockTrace.phase = 'buffering';
    if (!_wasBuffering) enterBufferingBarrier(null, null);
    _clockStartTime = S.currentTime;
    _clockStartWall = performance.now();
    _tickId = requestAnimationFrame(clockTick);
    return;
  }
  if (_wasBuffering) {
    playbackClockTrace.phase = 'alignment';
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
      playVideo(video, true);
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
    const maxSpread = playbackSpreadLimit(videos);
    const spread = Math.max(...videoTimes) - Math.min(...videoTimes);
    if (spread > maxSpread) {
      playbackClockTrace.phase = 'drift';
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

  playbackClockTrace.phase = 'ui';
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

  playbackClockTrace.phase = 'transition';
  reconcilePlaybackPosition();
  playbackClockTrace.phase = S.playing ? 'scheduled' : 'stopped';
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
      // Keep the same inset on both axes; only the top-left corner
      // needs clearance for the camera name.
      const label = cell.querySelector('.label-overlay');
      const top = horizontal === 'left' && label && x < label.offsetLeft + label.offsetWidth
        ? Math.max(y+8, label.offsetTop + label.offsetHeight + 4) : y+8;
      overlay.style.top = vertical === 'top' ? `${top}px` : 'auto';
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
