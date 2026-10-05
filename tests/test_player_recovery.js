const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const CtvMedia = require('../ctv_web/js/media.js');

function video({time = 10, buffered = 0, transport = 'mp4', played = true} = {}) {
  return {
    currentTime: time, readyState: 3, seeking: false, hidden: false,
    dataset: {hasPlayed: played ? '1' : '0', metadataReady: '1', warming: '0'},
    parentElement: {dataset: {
      recording: '1', start: '100', streamOffset: '0', streamSpeed: '1',
      playbackRate: '1', duration: '60', streamTransport: transport,
    }},
    buffered: {length: 1, start: () => time, end: () => time + buffered},
    plays: 0, pauses: 0,
    play() { this.plays++; return Promise.resolve(); },
    pause() { this.pauses++; },
    load() {}, removeAttribute() { this.src = ''; }, getAttribute() { return this.src || ''; },
  };
}

function setup(videos) {
  const context = vm.createContext({
    CtvMedia, S: {playing: true, currentTime: 110, speed: 1},
    document: {getElementById: () => ({addEventListener() {}}), addEventListener() {}, querySelectorAll: () => videos},
    window: {addEventListener() {}}, performance: {now: () => 1000},
    setTimeout: (...args) => { const timer = setTimeout(...args); timer.unref(); return timer; }, clearTimeout, AbortController,
    HTMLMediaElement: {HAVE_METADATA: 1, HAVE_CURRENT_DATA: 2, HAVE_FUTURE_DATA: 3},
    t: key => key, videos, restarted: [],
  });
  vm.runInContext(fs.readFileSync(require.resolve('../ctv_web/js/player.js'), 'utf8'), context);
  vm.runInContext(`
    activeVideos = () => videos;
    showFreezeFrame = () => {};
    setPlayerStatus = (cell, message) => { cell.dataset.buffering = message ? '1' : '0'; };
    restartProgressiveVideo = video => {
      restarted.push(video);
      video.currentTime = 0;
      video.parentElement.dataset.streamOffset = '10';
      video.dataset.hasPlayed = '0';
      video.dataset.warming = '0';
      video.buffered = {length: 0};
    };
  `, context);
  return context;
}

// Recovery must not replace a pending native seek on every clock tick.
{
  const native = video({transport: 'native'});
  const ctx = setup([native]);
  ctx.S.streamProfile = 'native';
  ctx.getVideos = () => [native];
  assert.equal(ctx.effectiveStreamProfile({id: 1}), 'native');
  vm.runInContext("_nativeFallbacks.add('1')", ctx);
  assert.equal(ctx.effectiveStreamProfile({id: 1}), 'balanced');
  assert.equal(ctx.effectiveStreamProfile({id: 2}), 'native');
  native.parentElement.dataset.streamTransport = 'mp4';
  assert.equal(ctx.hasCompressedPlayback(), true);
  ctx.S.streamProfile = 'fast';
  assert.equal(ctx.effectiveStreamProfile({id: 1}), 'fast');
}

{
  const native = video({time: 0, transport: 'native'});
  const ctx = setup([native]);
  native.seeking = true;
  for (let tick = 0; tick < 60; tick++) {
    assert.equal(ctx.seekVideo(native), false);
    assert.equal(ctx.alignVideos([native]), false);
    assert.equal(native.currentTime, 0);
  }
  native.seeking = false;
  assert.equal(ctx.seekVideo(native), true);
  assert.equal(native.currentTime, 10);
}

// A seek in an overestimated native tail must converge, including after Pause/Play.
{
  const native = video({time: 4, buffered: 0, transport: 'native', played: false});
  native.duration = 4;
  native.parentElement.dataset.duration = '6';
  const ctx = setup([native]);
  ctx.S.currentTime = 104.7;
  assert.equal(ctx.videoTargetTime(native), 3.95);
  assert.equal(ctx.alignVideos([native]), true, 'do not retry the unreachable 4.7s target');
  native.currentTime = 3.95;
  ctx.enterBufferingBarrier(null, null);
  assert.equal(ctx.videoHasPlaybackBuffer(native), true);
  assert.equal(ctx.alignVideos([native]), true);
  for (const duration of [NaN, Infinity]) {
    native.duration = duration;
    assert.ok(Math.abs(ctx.videoTargetTime(native) - 4.7) < 1e-8);
  }
  for (const transport of ['mp4', 'hls']) {
    native.duration = 4;
    native.parentElement.dataset.streamTransport = transport;
    assert.ok(Math.abs(ctx.videoTargetTime(native) - 4.7) < 1e-8,
      'a growing transcoded duration must not move the requested position backwards');
  }
}

// The last frames must play even when the index overestimates actual duration.
{
  const tail = video({time:3.85, buffered:0.15});
  tail.duration = 4;
  tail.parentElement.dataset.duration = '6';
  const ctx = setup([tail]);
  assert.equal(ctx.videoHasPlaybackBuffer(tail), true);
  ctx.enterBufferingBarrier(null, null);
  assert.equal(ctx.videoHasPlaybackBuffer(tail), true);
  tail.currentTime = 4; tail.ended = true;
  assert.equal(ctx.videoReachedEnd(tail), true, 'ended must escape the barrier');
}

// A starved camera must preserve its source and the healthy cameras' buffers.
{
  const slow = video(), healthy = video({buffered: 5});
  const ctx = setup([slow, healthy]);
  ctx.enterBufferingBarrier(slow, 'buffering');
  assert.equal(ctx.restarted.length, 0);
  assert.equal(slow.plays, 0, 'established MP4 must fill while paused');
  assert.equal(healthy.plays, 0);
  assert.equal(ctx.S.currentTime, 110);
  slow.buffered.end = () => 13;
  assert.equal(ctx.alignVideos([slow, healthy]), true);
  assert.equal(ctx.restarted.length, 0);
}

// Warm-up handshakes happen once per source even if waiting events repeat.
for (const transport of ['mp4', 'hls']) {
  const fresh = video({time: 0, transport, played: false});
  fresh.parentElement.dataset.streamOffset = '10';
  const ctx = setup([fresh]);
  ctx.enterBufferingBarrier(fresh, 'buffering');
  ctx.enterBufferingBarrier(fresh, 'buffering');
  assert.equal(fresh.plays, 1);
  const next = video({time: 0, transport, played: false});
  next.parentElement.dataset.streamOffset = '10';
  ctx.videos.push(next);
  ctx.enterBufferingBarrier(next, 'buffering');
  assert.equal(next.plays, 1, 'new sources must warm even during an existing barrier');
  assert.equal(fresh.plays, 1);
}

// Real drift still requires restarting the unseekable MP4, only that camera.
{
  const drifted = video({time: 11, buffered: 5}), aligned = video({buffered: 5});
  const ctx = setup([drifted, aligned]);
  ctx.enterBufferingBarrier(drifted, 'buffering');
  assert.equal(ctx.alignVideos([drifted, aligned]), false);
  assert.equal(ctx.restarted.length, 1);
  assert.equal(ctx.restarted[0], drifted);
  assert.equal(drifted.plays, 1);
  assert.equal(aligned.plays, 0);
  assert.equal(ctx.S.currentTime, 110);
}

// HLS must continue its existing playlist warm-up, without repeated play calls.
{
  const hls = video({transport: 'hls'}), ctx = setup([hls]);
  ctx.enterBufferingBarrier(hls, 'buffering');
  ctx.enterBufferingBarrier(hls, 'buffering');
  assert.equal(hls.plays, 1);
}

{
  assert.equal(CtvMedia.requiredPlaybackBuffer(1, 0, 45, false), 0.15);
  assert.equal(CtvMedia.requiredPlaybackBuffer(1, 0, 45, true), 0.75);
  assert.equal(CtvMedia.requiredPlaybackBuffer(16, 0, 45, false), 2.4);
  assert.equal(CtvMedia.requiredPlaybackBuffer(16, 0, 45, true), 4);
  const tail = video({time: 59.25});
  const ctx = setup([tail]);
  vm.runInContext('_wasBuffering = true', ctx);
  assert.equal(ctx.requiredBuffer(tail), 0.25, 'a larger recovery buffer must not stall the recording tail');
}

// A decoder frozen on its last frame must transition without an ended event.
for (const transport of ['native', 'mp4', 'hls']) {
  const tail = video({time: 3.96, buffered: 0.04, transport});
  tail.duration = 4;
  tail.ended = false;
  tail.networkState = 1;
  tail.parentElement.dataset.duration = transport === 'hls' ? '4' : '6';
  tail.dataset.recording = '1';
  const ctx = setup([tail]);
  let now = 1000;
  ctx.performance.now = () => now;
  assert.equal(ctx.videoReachedEnd(tail), false);
  now += 1499;
  assert.equal(ctx.videoReachedEnd(tail), false);
  now++;
  assert.equal(ctx.videoReachedEnd(tail), true);
  ctx.S.activeTab = 'timeline';
  ctx.requestAnimationFrame = () => 1;
  ctx.onVideoEnded = (v, id) => { ctx.transition = {v, id}; };
  ctx.clockTick();
  assert.equal(ctx.transition.v, tail);
  assert.equal(ctx.transition.id, '1');

  for (const state of ['paused', 'seeking', 'unplayed', 'unbuffered', 'unknownDuration', 'downloading', 'middle']) {
    ctx.S.playing = state !== 'paused';
    tail.seeking = state === 'seeking';
    tail.networkState = state === 'downloading' ? 2 : 1;
    tail.dataset.hasPlayed = state === 'unplayed' ? '0' : '1';
    tail.duration = state === 'unknownDuration' ? Infinity : 4;
    tail.buffered = state === 'unbuffered' ? {length: 0} :
      {length: 1, start: () => 0, end: () => 4};
    tail.currentTime = state === 'middle' ? 2 : 3.96;
    tail._endProgress = {time: tail.currentTime, since: 0};
    assert.equal(ctx.videoReachedEnd(tail), false, state);
  }
}

async function asyncTests() {
  // Transient failures in every transport reload only the failed camera,
  // keep the timeline, and stop retrying after two unsuccessful loads.
  for (const transport of ['native', 'mp4', 'hls']) {
    const broken = video({transport}); broken._generation = 1;
    broken.dataset.recording = '1';
    const retry = setup([broken]); retry.appUrl = value => value;
    retry.fetch = async () => ({ok:true});
    let reloads = 0;
    retry.renderPlayers = () => { reloads++; broken._generation++; };
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.equal(await retry.retryMediaSource(broken, 7, 4), true);
      assert.equal(retry.S.currentTime, 110);
    }
    assert.equal(reloads, 2);
    assert.equal(await retry.retryMediaSource(broken, 7, 4), false);
    assert.equal(await retry.retryMediaSource(broken, 7, 1), false);
  }
  // An obsolete health response must not reload a newer user seek.
  const obsolete = video({transport:'native'}); obsolete._generation = 1;
  const stale = setup([obsolete]); stale.appUrl = value => value;
  let healthReply;
  stale.fetch = () => new Promise(resolve => { healthReply = resolve; });
  let staleReloads = 0; stale.renderPlayers = () => { staleReloads++; };
  const pendingRetry = stale.retryMediaSource(obsolete, 7, 2);
  obsolete._generation++;
  healthReply({ok:true});
  assert.equal(await pendingRetry, true);
  assert.equal(staleReloads, 0);

  // A delayed admission from an old seek cannot replace the latest video URL.
  const v = video(); v._generation = 1;
  const ctx = setup([v]); ctx.appUrl = value => value;
  let resolveAdmission;
  const requests = [];
  ctx.fetch = (url, options) => {
    requests.push({url, options});
    if (options.method === 'POST') return new Promise(resolve => { resolveAdmission = resolve; });
    return Promise.resolve({ok:true});
  };
  const loading = ctx.loadCompressedSource(v, {session_id:'old'}, '/old-video');
  await Promise.resolve();
  v._generation++;
  v.src = '/new-video';
  resolveAdmission({ok:true});
  await loading;
  assert.equal(v.src, '/new-video');
  assert(requests.some(r => r.url === '/api/playback-sessions/old' && r.options.method === 'DELETE'));

  const fresh = video(); fresh._generation = 1;
  const capacity = setup([fresh]); capacity.appUrl = value => value;
  capacity.fetch = async () => ({ok:false, json:async()=>({detail:'capacity'})});
  capacity.failPlayback = code => { capacity.failure = code; capacity.S.playing = false; };
  await capacity.loadCompressedSource(fresh, {session_id:'new'}, '/new-video');
  assert.equal(capacity.failure, 'capacity');
  assert.equal(capacity.S.playing, false);
  assert.equal(fresh.src, undefined);
}

asyncTests().then(() => console.log('Player recovery tests passed')).catch(error => {
  console.error(error); process.exitCode = 1;
});
