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

async function asyncTests() {
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
