/* Opt-in persistent session recorder. Observes playback; never restarts it. */
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
  function accumulateSession(totals, previous, current) {
    if (!previous) return;
    const dt = current.wall - previous.wall;
    if (dt <= 0) return;
    // Browser suspension and timer throttling are not continuously observed
    // playback. Keep these gaps separate from measured progress and stalls.
    if (dt > 5000 || previous.hidden || current.hidden) {
      totals.unobservedMs += dt; return;
    }
    totals.observedMs += dt;
    if (!previous.playing || !current.playing) return;
    totals.playingMs += dt;
    if (previous.buffering || current.buffering) totals.bufferingMs += dt;
    const advance = current.time - previous.time;
    if (!Number.isFinite(advance)) return;
    // Exclude large seeks from throughput. This is sampled telemetry; small
    // seeks can still resemble progress and are documented as a limitation.
    const maximum = dt / 1000 * Math.max(previous.speed || 1, current.speed || 1) * 2 + 0.5;
    if (advance < -0.01 || advance > maximum) { totals.discontinuities++; return; }
    if (Math.abs(advance) <= 0.001) totals.stalledMs += dt;
    else if (advance > 0) totals.timelineSeconds += advance;
  }
  // Repeated media events are counted per second, source and generation.
  // Samples are never rotated: only the pending write batch stays in memory.
  class EventBuckets {
    constructor() { this.items = new Map(); }
    add(entry, details) {
      const v = entry.video || {};
      const key = JSON.stringify([Math.floor(entry.wall / 1000), entry.type,
        v.camera, v.recording, v.generation, entry.name, entry.control, entry.requestId, entry.route, entry.status, entry.method, entry.camera, entry.recording]);
      const previous = this.items.get(key);
      if (previous) {
        previous.count++; previous.lastWall = entry.wall;
        if (Number.isFinite(entry.durationMs)) {
          previous.durationTotalMs += entry.durationMs;
          previous.durationMinMs = Math.min(previous.durationMinMs, entry.durationMs);
          previous.durationMaxMs = Math.max(previous.durationMaxMs, entry.durationMs);
        }
      } else this.items.set(key, {...entry, ...details?.(), count:1, lastWall:entry.wall,
        ...(Number.isFinite(entry.durationMs) ? {durationTotalMs:entry.durationMs,
          durationMinMs:entry.durationMs,durationMaxMs:entry.durationMs} : {})});
    }
    drain() { const result = Array.from(this.items.values()); this.items.clear(); return result; }
  }
  root.CtvPlaybackTrace = {boundedPush, videoState, errorText, accumulateSession, EventBuckets};
  if (!root.document) return;
  const doc = root.document, flag = 'ctvPlaybackTraceEnabled', saved = 'ctvPlaybackTraceSaved';
  const toggle = doc.getElementById('playback-trace-enabled');
  const stopButton = doc.getElementById('btn-playback-trace-stop');
  const downloadButton = doc.getElementById('btn-playback-trace');
  const status = doc.getElementById('playback-trace-status');
  let db, meta = null, active = false, timer, observer, listeners = [];
  let samples = [], buckets = new EventBuckets(), previous = null, failedChunks = [];
  let writes = Promise.resolve(), pendingWrites = 0, lifecycle = Promise.resolve();
  let origin = 0, elapsed = 0;
  function preference(key, value) {
    try { if (value !== undefined) localStorage.setItem(key, value); return localStorage.getItem(key); }
    catch { return null; }
  }
  function ui(key) {
    if (status) { status.dataset.i18n = key; status.textContent = root.t?.(key) || key; }
    if (toggle) toggle.checked = active;
    if (stopButton) stopButton.disabled = !active;
    if (downloadButton) downloadButton.disabled = !meta;
    if (toggle) toggle.disabled = key === 'player.traceStarting';
  }
  function openStore() {
    if (db) return Promise.resolve(db);
    return new Promise((resolve, reject) => {
      const request = root.indexedDB.open('ctv-playback-session-v2', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('meta');
        request.result.createObjectStore('chunks', {autoIncrement:true});
      };
      request.onsuccess = () => {
        db = request.result;
        db.onversionchange = () => { db.close(); db = null; fail(Error('Storage changed')); };
        resolve(db);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(Error('Storage unavailable'));
    });
  }
  function transaction(mode, operation) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['meta','chunks'], mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(tx.error || Error('Storage transaction failed'));
      operation(tx, value => { result = value; });
    });
  }
  const now = () => Math.round(elapsed + root.performance.now() - origin);
  function listen(target, type, handler, capture = false) {
    target.addEventListener(type, handler, capture);
    listeners.push(() => target.removeEventListener(type, handler, capture));
  }
  function detach() {
    active = false; root.clearInterval(timer); observer?.disconnect(); observer = null;
    listeners.splice(0).forEach(remove => remove());
  }
  function fail(reason) {
    detach(); preference(flag, '0');
    if (meta) { meta.complete = false; meta.storageError = errorText(reason?.name || reason?.message || reason); }
    ui('player.traceStorageError');
  }
  function event(type, details = {}) {
    if (!active) return;
    buckets.add({wall:now(), type, ...details});
    // Fail visibly instead of letting a unique-event storm exhaust memory.
    if (buckets.items.size > 2000) { flush(); fail(Error('Event backlog')); }
  }
  function sample() {
    if (!active) return;
    const state = root.ctvPlaybackState?.() || {};
    const current = {wall:now(), hidden:doc.hidden, ...state,
      videos:Array.from(doc.querySelectorAll('#player-area video')).slice(0,16).map(videoState)};
    accumulateSession(meta.session, previous, current); previous = current;
    samples.push(current); meta.sampleCount++; meta.lastWall = current.wall;
    meta.lastSample = current;
  }
  function flush() {
    if (!meta || (!samples.length && !buckets.items.size)) return writes;
    const chunk = {samples:samples.splice(0), events:buckets.drain()};
    meta.eventCount += chunk.events.reduce((n,e) => n + e.count, 0);
    meta.chunkCount++; chunk.sequence=meta.chunkCount;
    meta.playerDiagnostics = root.ctvPlaybackDiagnostics?.() || null;
    const snapshot = JSON.parse(JSON.stringify(meta));
    pendingWrites++;
    writes = writes.then(async () => {
      if (failedChunks.length) { failedChunks.push(chunk); return; }
      try {
        await transaction('readwrite', tx => {
          tx.objectStore('chunks').add(chunk, chunk.sequence);
          tx.objectStore('meta').put(snapshot, 'latest');
        });
      } catch (reason) { failedChunks.push(chunk); fail(reason); }
    }).finally(() => { pendingWrites--; });
    if (pendingWrites >= 4) fail(Error('Storage write backlog'));
    return writes;
  }
  function route(name) {
    try {
      const path = new URL(name, root.location.href).pathname;
      if (/\/video\/\d+/.test(path)) return 'native-video';
      if (/\/stream\/\d+/.test(path)) return 'mp4-stream';
      if (/\/hls\//.test(path)) return /\.m3u8$/.test(path) ? 'hls-playlist' : 'hls-segment';
      if (/\/api\/playback-sessions/.test(path)) return 'playback-session';
      if (/\/api\/timeline\/prepare$/.test(path)) return 'timeline-prepare';
      if (/\/api\/timeline$/.test(path)) return 'timeline';
    } catch {}
    return null;
  }
  root.ctvTraceAction = event;
  root.ctvTraceEnabled = () => active;
  root.ctvFlushPlaybackTrace = () => { sample(); return flush(); };
  root.ctvTraceApiStart = (url, method) => active ? {wall:now(), route:route(url), method} : null;
  root.ctvTraceApiEnd = (request, statusCode, ok) => {
    if (request) event('api-response', {route:request.route, method:request.method, startWall:request.wall, durationMs:now()-request.wall, status:statusCode, ok});
  };
  function mediaEvent(type, video, reason) {
    if (!active) return;
    buckets.add({wall:now(), type, name:reason?.name, video:{camera:video.parentElement?.dataset.cam,
      recording:video.dataset.recording,generation:video._generation}},
      () => ({video:videoState(video), ...(reason ? {message:errorText(reason?.message || reason)} : {})}));
    if (buckets.items.size > 2000) { flush(); fail(Error('Event backlog')); }
  }
  root.ctvTracePlayRejected = (video, reason) => mediaEvent('play-rejected', video, reason);
  function attach() {
    for (const type of ['play','playing','pause','waiting','stalled','seeking','seeked','ended','error']) {
      listen(doc, type, e => {
        if (e.target.tagName === 'VIDEO' && e.target.closest('#player-area')) mediaEvent(type, e.target);
      }, true);
    }
    listen(doc, 'visibilitychange', () => { event('visibility', {hidden:doc.hidden}); sample(); flush(); });
    listen(doc, 'click', e => {
      if (e.target.closest?.('#btn-play')) event('play-button', root.ctvPlaybackState?.());
    }, true);
    listen(doc, 'change', e => {
      if (['speed-select','quality-select','preload-select','timeline-date','layout-select'].includes(e.target.id))
        event('control-change', {control:e.target.id, value:e.target.value});
    }, true);
    listen(root, 'error', e => {
      if (e.message) event('javascript-error', {message:errorText(e.message), line:e.lineno, column:e.colno});
    });
    listen(root, 'unhandledrejection', e => event('unhandled-rejection', {
      name:e.reason?.name, message:errorText(e.reason?.message || e.reason)}));
    listen(root, 'resize', () => event('resize', {width:root.innerWidth,height:root.innerHeight}));
    listen(root, 'pagehide', () => { event('pagehide'); sample(); flush(); root.clearInterval(timer); });
    listen(root, 'pageshow', e => {
      if (e.persisted) { event('pageshow'); root.clearInterval(timer); startTimer(); }
    });
    if (root.PerformanceObserver) {
      try {
        observer = new root.PerformanceObserver(list => {
          for (const entry of list.getEntries()) {
            const label = route(entry.name);
            if (label) event('resource', {route:label, durationMs:Math.round(entry.duration),
              transferBytes:entry.transferSize, encodedBytes:entry.encodedBodySize,
              decodedBytes:entry.decodedBodySize});
          }
        });
        observer.observe({entryTypes:['resource']});
      } catch { observer = null; }
    }
    startTimer();
  }
  function startTimer() {
    let ticks = 0;
    timer = root.setInterval(() => { sample(); if (++ticks % 5 === 0) flush(); }, 1000);
  }
  async function start(resume = false) {
    if (active) return;
    ui('player.traceStarting');
    try {
      await openStore();
      if (resume) meta = await transaction('readonly', (tx, done) => {
        const req=tx.objectStore('meta').get('latest'); req.onsuccess=()=>done(req.result || null);
      });
      if (!resume || !meta || meta.stoppedAt || meta.storageError) {
        meta = {schema:2, startedAt:new Date().toISOString(), startedAtEpoch:Date.now(),
          complete:false, sampleCount:0,eventCount:0,chunkCount:0,pages:0,lastWall:0,
          userAgent:root.navigator.userAgent, viewport:{width:root.innerWidth,height:root.innerHeight},
          playerBuild:doc.querySelector('script[src*="js/player.js"]')?.getAttribute('src')?.split('?')[1],
          eventAggregation:'Identical events per second/source/generation: count and lastWall; first state retained.',
          measurement:'1-second samples; bufferingMs is sampled. playerDiagnostics has exact barrier durations per page. Resource timing covers completed requests only.',
          session:{observedMs:0,playingMs:0,bufferingMs:0,stalledMs:0,timelineSeconds:0,discontinuities:0,unobservedMs:0}};
        await transaction('readwrite', tx => { tx.objectStore('chunks').clear(); tx.objectStore('meta').put(meta,'latest'); });
      }
      elapsed = Math.max(meta.lastWall || 0, Date.now() - meta.startedAtEpoch);
      origin = root.performance.now(); previous = meta.lastSample || null;
      samples = []; buckets = new EventBuckets(); failedChunks=[];
      meta.pages++; active=true; preference(flag,'1'); preference(saved,'1'); attach();
      event(resume ? 'page-resume' : 'session-start', {page:meta.pages}); sample(); flush(); ui('player.traceActive');
    } catch (reason) { fail(reason); }
  }
  async function stop() {
    if (!active) return;
    event('session-stop'); sample(); meta.stoppedAt=new Date().toISOString(); meta.complete=true;
    detach(); preference(flag,'0'); await flush();
    ui(meta.storageError ? 'player.traceStorageError' : 'player.traceStopped');
  }
  function queue(operation) {
    lifecycle=lifecycle.then(operation).catch(fail); return lifecycle;
  }
  root.ctvSetPlaybackTraceEnabled = enabled => queue(() => enabled ? start() : stop());
  toggle?.addEventListener('change', () => root.ctvSetPlaybackTraceEnabled(toggle.checked));
  stopButton?.addEventListener('click', () => root.ctvSetPlaybackTraceEnabled(false));
  async function eachChunk(maximum, visit) {
    await transaction('readonly', tx => {
      const req=tx.objectStore('chunks').openCursor();
      req.onsuccess=()=>{ const cursor=req.result; if (!cursor || cursor.key > maximum) return;
        visit(cursor.value); cursor.continue(); };
    });
  }
  async function snapshot() {
    await lifecycle;
    if (!meta) return null;
    sample(); const flushed=flush();
    const header=JSON.parse(JSON.stringify(meta));
    await flushed;
    if (meta.storageError) header.storageError=meta.storageError;
    return {...header, failedChunks:failedChunks.filter(chunk=>chunk.sequence <= header.chunkCount),
      createdAt:new Date().toISOString(),
      session:{...header.session, effectiveRate:header.session.playingMs > 0
        ? header.session.timelineSeconds/(header.session.playingMs/1000) : null},
      complete:!!header.stoppedAt && !header.storageError};
  }
  root.ctvExportPlaybackTrace = async () => {
    const header = await snapshot(); if (!header) return null;
    const result={...header,samples:[],events:[],errors:[]};
    const add=chunk=>{result.samples.push(...chunk.samples);result.events.push(...chunk.events);};
    await eachChunk(header.chunkCount,add); header.failedChunks.forEach(add);
    delete result.failedChunks;
    result.errors=result.events.filter(e=>['javascript-error','unhandled-rejection'].includes(e.type));
    delete result.lastSample; return result;
  };
  downloadButton?.addEventListener('click', async () => {
    downloadButton.disabled=true;
    try {
      const header=await snapshot(); if (!header) return;
      const extraChunks=header.failedChunks;
      delete header.failedChunks; delete header.lastSample;
      const parts=[JSON.stringify(header).slice(0,-1)];
      for (const kind of ['samples','events','errors']) {
        parts.push(',"'+kind+'":['); let first=true;
        const add=chunk=>{
          const entries=kind==='errors' ? chunk.events.filter(e=>['javascript-error','unhandled-rejection'].includes(e.type)) : chunk[kind];
          if (entries.length) { parts.push((first?'':',')+JSON.stringify(entries).slice(1,-1)); first=false; }
        };
        await eachChunk(header.chunkCount,add); extraChunks.forEach(add); parts.push(']');
      }
      parts.push('}');
      const blob=new Blob(parts,{type:'application/json'}), url=URL.createObjectURL(blob), link=doc.createElement('a');
      link.href=url; link.download='cctv-playback-trace.json';doc.body.appendChild(link);link.click();link.remove();
      root.setTimeout(()=>URL.revokeObjectURL(url),30000);
    } catch { ui('player.traceDownloadError'); }
    finally { downloadButton.disabled=!meta; }
  });
  ui('player.traceDisabled');
  root.ctvPlaybackTraceReady = queue(async () => {
    if (preference(flag)==='1') await start(true);
    else if (preference(saved)==='1') {
      try {
        await openStore(); meta=await transaction('readonly',(tx,done)=>{
          const req=tx.objectStore('meta').get('latest');req.onsuccess=()=>done(req.result || null);
        });
        if (meta) ui(meta.storageError || !meta.stoppedAt ? 'player.traceStorageError' : 'player.traceStopped');
      } catch { ui('player.traceStorageError'); }
    }
  });
})(typeof window === 'undefined' ? globalThis : window);
