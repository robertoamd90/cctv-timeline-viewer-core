/* Bounded local flight recorder. Observes playback; never restarts it. */
(function(root) {
  function boundedPush(items, value, limit) {
    items.push(value);
    if (items.length > limit) items.splice(0, items.length - limit);
  }
  function videoState(video) {
    const cell = video.parentElement;
    const quality = video.getVideoPlaybackQuality?.();
    return {
      camera: cell?.dataset.cam, recording: video.dataset.recording,
      generation: video._generation, transport: cell?.dataset.streamTransport,
      start: cell?.dataset.start, offset: cell?.dataset.streamOffset,
      encodedSpeed: cell?.dataset.streamSpeed, indexedDuration: cell?.dataset.duration,
      playbackRate: video.playbackRate,
      mediaTime: video.currentTime, duration: Number.isFinite(video.duration) ? video.duration : null,
      ready: video.readyState, network: video.networkState, paused: video.paused,
      seeking: video.seeking, ended: video.ended, hidden: video.hidden,
      warming: video.dataset.warming, played: video.dataset.hasPlayed,
      buffering: cell?.dataset.buffering, failed: cell?.dataset.failed,
      error: video.error?.code || null,
      frames: quality?.totalVideoFrames ?? video.webkitDecodedFrameCount ?? null,
      dropped: quality?.droppedVideoFrames ?? video.webkitDroppedFrameCount ?? null,
      buffered: Array.from({length: Math.min(video.buffered.length, 8)}, (_, i) =>
        [video.buffered.start(i), video.buffered.end(i)]),
    };
  }
  // Do not retain source URLs, Ingress tokens, camera names or filesystem paths.
  function errorText(value) {
    return String(value || '').replace(/(?:https?:\/\/|\/)[^\s"'<>]+/g, '[path]').slice(0, 500);
  }
  root.CtvPlaybackTrace = {boundedPush, videoState, errorText};
  if (!root.document) return;
  const samples = [], events = [], errors = [];
  const now = () => Math.round(root.performance.now());
  function sample() {
    const state = root.ctvPlaybackState?.();
    if (!state) return;
    boundedPush(samples, {wall: now(), hidden: document.hidden, ...state,
      videos: Array.from(document.querySelectorAll('#player-area video')).slice(0, 16).map(videoState)}, 300);
  }
  function event(type, details = {}) {
    boundedPush(events, {wall: now(), type, ...details}, 256);
  }
  root.ctvTracePlayRejected = (video, reason) => event('play-rejected', {
    name: reason?.name, message: errorText(reason?.message || reason), video: videoState(video),
  });
  for (const type of ['play', 'playing', 'pause', 'waiting', 'stalled', 'seeking', 'seeked', 'ended', 'error']) {
    document.addEventListener(type, e => {
      if (e.target.tagName === 'VIDEO' && e.target.closest('#player-area')) {
        event(type, {video: videoState(e.target)});
      }
    }, true);
  }
  document.addEventListener('visibilitychange', () => event('visibility', {hidden: document.hidden}));
  document.getElementById('btn-play')?.addEventListener('click', () => event('play-button', root.ctvPlaybackState?.()), true);
  function error(type, details) {
    const entry = {wall: now(), type, ...details};
    boundedPush(errors, entry, 64);
    boundedPush(events, entry, 256);
  }
  root.addEventListener('error', e => {
    if (e.message) error('javascript-error', {
      message: errorText(e.message), line: e.lineno, column: e.colno,
    });
  });
  root.addEventListener('unhandledrejection', e => error('unhandled-rejection', {
    name: e.reason?.name, message: errorText(e.reason?.message || e.reason),
  }));
  root.addEventListener('resize', () => event('resize', {width: innerWidth, height: innerHeight}));
  let timer = root.setInterval(sample, 1000);
  root.addEventListener('pagehide', () => { sample(); root.clearInterval(timer); });
  root.addEventListener('pageshow', e => {
    if (e.persisted) { root.clearInterval(timer); timer = root.setInterval(sample, 1000); }
  });
  root.ctvExportPlaybackTrace = () => {
    sample();
    return {schema: 1, createdAt: new Date().toISOString(), userAgent: navigator.userAgent,
      viewport: {width: innerWidth, height: innerHeight},
      playerBuild: document.querySelector('script[src*="js/player.js"]')?.getAttribute('src')?.split('?')[1],
      samples: samples.slice(), events: events.slice(), errors: errors.slice()};
  };
  document.getElementById('btn-playback-trace')?.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(root.ctvExportPlaybackTrace(), null, 2)], {type: 'application/json'});
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = 'cctv-playback-trace.json';
    document.body.appendChild(link); link.click(); link.remove();
    root.setTimeout(() => URL.revokeObjectURL(url), 30000);
  });
})(typeof window === 'undefined' ? globalThis : window);
