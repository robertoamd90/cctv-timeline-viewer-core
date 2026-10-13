const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const CtvMedia = require('../ctv_web/js/media.js');

function video({time = 10, buffered = 0, transport = 'mp4', played = true} = {}) {
  return {
    currentTime: time, readyState: transport === 'native' ? 4 : 3, seeking: false, hidden: false,
    dataset: {recording: '1', hasPlayed: played ? '1' : '0', metadataReady: '1', warming: '0'},
    parentElement: {querySelector: () => ({hidden:false}), dataset: {
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
    updateEventOverlays = () => {};
    clearFreezeFrame = () => {};
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

// Decoder failure isolates a tile, preserves other sources and global playback.
for (const transport of ['native', 'mp4', 'hls']) {
  const broken = video({transport}), healthy = video({buffered:5});
  healthy.parentElement.dataset.recording = '2';
  healthy.src = '/healthy';
  const ctx = setup([broken, healthy]);
  ctx.failVideo(broken);
  assert.equal(ctx.S.playing, true);
  assert.equal(ctx.S.currentTime, 110);
  assert.equal(broken.parentElement.dataset.failed, '1');
  assert.equal(broken.hidden, true);
  assert.equal(healthy.src, '/healthy');
  assert.equal(ctx.activeVideos().length, 1);
  assert.equal(ctx.activeVideos()[0], healthy);
  ctx.retryFailedRecordings();
  assert.equal(vm.runInContext('_failedRecordings.size',ctx),0);
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
  // A pending Play can start at an old effective rate even if the getter already
  // reports 1. Reapply priming once it resolves; stale handshakes cannot touch it.
  {
    const v=video({buffered:20,transport:'native'});let writes=[];
    Object.defineProperty(v,'playbackRate',{get:()=>1,set:value=>writes.push(value)});
    const ctx=setup([v]);vm.runInContext('_wasBuffering=true;',ctx);
    await ctx.playVideo(v);assert.deepEqual(writes,[1]);
    let resolve;v.play=()=>new Promise(done=>{resolve=done;});
    const old=ctx.playVideo(v);v._generation=2;resolve();await old;
    assert.deepEqual(writes,[1]);
  }

  // pause() aborts a pending play asynchronously. Its rejection must not
  // re-enter the barrier after a newer resume of the very same source.
  const resumed = video({buffered:5,transport:'native'});
  const race = setup([resumed]);
  race.S.activeTab = 'timeline';
  race.requestAnimationFrame = () => 1;
  race.cancelAnimationFrame = () => {};
  race.updatePlaybackUi = race.updateAutoHotspot = race.revealFreezeOnNextFrame = () => {};
  let rejectOldPlay;
  resumed.play = () => {
    resumed.plays++;
    return resumed.plays === 1 ? new Promise((_, reject) => {rejectOldPlay = reject;}) : Promise.resolve();
  };
  race.enterBufferingBarrier(null,null);
  race.clockTick();
  race.enterBufferingBarrier(null,null); // interrupts the pending first play
  race.clockTick(); // a new play succeeds, with the same generation and epoch
  assert.equal(vm.runInContext('_wasBuffering',race),false);
  rejectOldPlay(Object.assign(new Error('Interrupted by pause'),{name:'AbortError'}));
  await Promise.resolve();
  assert.equal(vm.runInContext('_wasBuffering',race),false,
    'an intentionally superseded play must not pause the resumed decoders');
  let rejectLatestPlay;
  resumed.play = () => new Promise((_,reject) => {rejectLatestPlay = reject;});
  race.enterBufferingBarrier(null,null);
  race.clockTick();
  rejectLatestPlay(new Error('Current playback failed'));
  await Promise.resolve();
  assert.equal(vm.runInContext('_wasBuffering',race),true,
    'a failure of the current play attempt must still be handled');
  // Browser policy refusal cannot be repaired by repeatedly pausing/resuming
  // fully buffered sources. Expose the refusal and leave Play inactive.
  race.updatePlayButton = () => {};
  race.clockTick();
  rejectLatestPlay(Object.assign(new Error('User activation required'),{name:'NotAllowedError'}));
  await Promise.resolve();
  assert.equal(race.S.playing,false,'browser-denied playback must not loop with Play active');
  for (const transport of ['native','mp4','hls']) {
    const warming = video({buffered:0,transport,played:false});
    const denied = setup([warming]);
    denied.updatePlayButton = () => {};
    warming.play = () => Promise.reject(Object.assign(new Error('Blocked'),{name:'NotAllowedError'}));
    denied.enterBufferingBarrier(null,null);
    await Promise.resolve();
    assert.equal(denied.S.playing,false,`${transport} warm-up refusal must be exposed`);
    assert.equal(vm.runInContext('_failedRecordings.size',denied),0,
      'browser policy refusal must not label a valid file as corrupt');
  }
  const staleVideo = video({buffered:5});
  const staleDenied = setup([staleVideo]);
  let rejectSuperseded;
  staleVideo.play = () => new Promise((_,reject) => {rejectSuperseded = reject;});
  staleDenied.playVideo(staleVideo,true);
  staleDenied.pauseVideo(staleVideo);
  staleVideo.play = () => Promise.resolve();
  await staleDenied.playVideo(staleVideo,true);
  rejectSuperseded(Object.assign(new Error('Old refusal'),{name:'NotAllowedError'}));
  await Promise.resolve();
  assert.equal(staleDenied.S.playing,true,'old policy errors must not stop a newer resume');

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
  await capacity.loadCompressedSource(fresh, {session_id:'new'}, '/new-video');
  assert.equal(fresh.parentElement.dataset.failed, '1');
  assert.equal(vm.runInContext("_failedRecordings.get('1')",capacity), 'capacity');
  assert.equal(capacity.S.playing, true);
  assert.equal(fresh.src, '');
}

asyncTests().then(() => console.log('Player recovery tests passed')).catch(error => {
  console.error(error); process.exitCode = 1;
});

// Buffered decoders can freeze silently: isolate them without stopping playback.
{
  const frozen = video({transport:'native', buffered:5});
  frozen.src = '/frozen';
  const ctx = setup([frozen]);
  let now = 1000; ctx.performance.now = () => now;
  ctx.checkVideoProgress(frozen);
  now += 7999; ctx.checkVideoProgress(frozen);
  assert.notEqual(frozen.parentElement.dataset.failed, '1');
  frozen.currentTime += 0.2; ctx.checkVideoProgress(frozen);
  now += 7999; ctx.checkVideoProgress(frozen);
  assert.notEqual(frozen.parentElement.dataset.failed, '1');
  now++; ctx.checkVideoProgress(frozen);
  assert.equal(frozen.parentElement.dataset.failed, '1');
  assert.equal(ctx.S.playing, true);
}
for (const state of ['paused', 'buffering', 'seeking', 'unplayed', 'unbuffered']) {
  const v = video({transport:'native', buffered:5});
  const ctx = setup([v]); let now = 1000; ctx.performance.now = () => now;
  ctx.checkVideoProgress(v);
  if (state === 'paused') ctx.S.playing = false;
  if (state === 'buffering') vm.runInContext('_wasBuffering = true', ctx);
  if (state === 'seeking') v.seeking = true;
  if (state === 'unplayed') v.dataset.hasPlayed = '0';
  if (state === 'unbuffered') v.buffered = {length:0};
  now += 9000; ctx.checkVideoProgress(v);
  assert.notEqual(v.parentElement.dataset.failed, '1', state);
}

// If every decoder freezes while Play remains active, the clock must resume
// from wall time after isolating the frozen tiles, including at mobile speeds.
for (const speed of [1, 16]) {
  const frozen = [video({transport:'native', buffered:5}), video({transport:'native', buffered:5})];
  frozen[1].dataset.recording = frozen[1].parentElement.dataset.recording = '2';
  const ctx = setup(frozen); let now = 1000;
  ctx.performance.now = () => now;
  ctx.S.speed = speed; ctx.S.activeTab = 'timeline';
  ctx.requestAnimationFrame = () => 1;
  ctx.updatePlaybackUi = () => {};
  ctx.updateAutoHotspot = () => {};
  vm.runInContext('_clockStartTime = S.currentTime; _clockStartWall = performance.now()', ctx);
  ctx.clockTick();
  now += 8000; ctx.clockTick();
  assert.equal(ctx.S.playing, true);
  assert.ok(frozen.every(v => v.parentElement.dataset.failed === '1'));
  now += 1000; ctx.clockTick();
  assert.equal(ctx.S.currentTime, 110 + speed);
}

// Seeking during a buffering barrier must not remove its recovery deadline.
{
  const v = video({buffered:0}); const ctx = setup([v]);
  ctx.enterBufferingBarrier(v, 'buffering');
  ctx.resetPlaybackRecovery();
  ctx.enterBufferingBarrier(v, 'buffering');
  assert.equal(vm.runInContext('_recoveryStarted', ctx), 1000);
  // An already-active barrier with a missing deadline must repair itself too.
  vm.runInContext('_recoveryStarted = null', ctx);
  ctx.enterBufferingBarrier(v, 'buffering');
  assert.equal(vm.runInContext('_recoveryStarted', ctx), 1000);
}
// Data in a warming buffer cannot make a pending seek ready.
{
  const v = video({buffered:5}); const ctx = setup([v]);
  v.dataset.warming = '1'; v.seeking = true;
  assert.equal(ctx.videoHasPlaybackBuffer(v), false);
  v.seeking = false;
  assert.equal(ctx.videoHasPlaybackBuffer(v), true);
}

// Accepted media alignment must also be accepted by the timeline clock.
// Encoded 16x HLS can have a small startup phase difference with full buffers.
for (const transport of ['mp4', 'hls']) {
  const early = video({time:0, buffered:5, transport});
  const late = video({time:0.09, buffered:5, transport});
  for (const v of [early,late]) v.parentElement.dataset.streamSpeed = '16';
  const ctx = setup([early,late]);
  ctx.S.speed = 16; ctx.S.currentTime = 100.001;
  assert.equal(ctx.alignVideos([early,late]), true);
  const spread = Math.abs(ctx.absoluteVideoTime(early)-ctx.absoluteVideoTime(late));
  assert.ok(spread <= ctx.playbackSpreadLimit([early,late]),
    'do not immediately reject the alignment just accepted by the barrier');
  assert.ok(ctx.playbackSpreadLimit([early,late]) <= 3.2);
  ctx.S.activeTab = 'timeline';
  ctx.requestAnimationFrame = () => 1;
  ctx.updatePlaybackUi = () => {};
  ctx.updateAutoHotspot = () => {};
  ctx.enterBufferingBarrier(null,null);
  ctx.revealFreezeOnNextFrame = () => {};
  ctx.clockTick();
  assert.equal(vm.runInContext('_wasBuffering',ctx),false,
    'ready decoders must escape the barrier instead of looping Pause/Play');
  const initial=ctx.S.currentTime;
  for(let tick=0;tick<20;tick++) {
    early.currentTime+=0.02; late.currentTime+=0.02;
    ctx.clockTick();
    assert.equal(vm.runInContext('_wasBuffering',ctx),false);
  }
  assert.ok(ctx.S.currentTime > initial+6);
}
{
  const v = video({transport:'native'}); const ctx=setup([v]);
  ctx.S.speed=16;
  assert.equal(ctx.playbackSpreadLimit([v]),0.5);
  ctx.S.speed=1;
  assert.equal(ctx.playbackSpreadLimit([v]),0.25);
}
// A real encoded outlier still enters the barrier; this is not unrestricted drift.
{
  const videos=[video({time:0,buffered:5,transport:'hls'}),video({time:0.3,buffered:5,transport:'hls'})];
  for(const v of videos) v.parentElement.dataset.streamSpeed='16';
  const ctx=setup(videos);ctx.S.speed=16;ctx.S.currentTime=100;ctx.S.activeTab='timeline';
  ctx.requestAnimationFrame=()=>1;
  ctx.clockTick();
  assert.equal(vm.runInContext('_wasBuffering',ctx),true);
  assert.equal(ctx.S.currentTime,100);
}

// Physical-phone trace: 16x native remains paused at a two-second buffer.
// Priming keeps playback eligible without weakening the 4s resume threshold.
{
  const v = video({time:0, buffered:1.991, transport:'native'});
  v.parentElement.dataset.playbackRate = '16';
  const ctx = setup([v]); ctx.S.currentTime=100; ctx.S.speed=16;
  ctx.enterBufferingBarrier(null,null);
  assert.equal(ctx.requiredBuffer(v),4);
  assert.equal(ctx.videoHasPlaybackBuffer(v),false);
  assert.equal(v.playbackRate,1);
  assert.equal(ctx.keepVideoWarming(v),true);
  for (const transport of ['mp4','hls']) {
    v.parentElement.dataset.streamTransport=transport;
    assert.equal(ctx.keepVideoWarming(v),transport==='hls');
  }
}
// Physical trace: currentTime is retained 496ms behind the buffered range.
// Re-request the authoritative target once, without a repeated-seek storm.
{
  const v = video({time:6.1306998, transport:'native'});
  v.buffered={length:1,start:()=>6.6270275,end:()=>44.074};
  v.parentElement.dataset.start='100';
  const ctx=setup([v]);ctx.S.currentTime=106.1306998;
  ctx.enterBufferingBarrier(null,null);
  let assignments=0, media=v.currentTime;
  Object.defineProperty(v,'currentTime',{get:()=>media,set:value=>{assignments++;media=value;}});
  v.paused=true;
  for(let tick=0;tick<60;tick++) ctx.warmNativeBuffer(v);
  assert.equal(assignments,1);
  assert.ok(Math.abs(media-6.1306998)<1e-7);
  assert.equal(v.playbackRate,1);
  v.seeking=true;ctx.warmNativeBuffer(v);assert.equal(assignments,1);
  v.seeking=false;v._generation=2;ctx.warmNativeBuffer(v);assert.equal(assignments,2);
}

// A tile that was ready when the barrier began can lose buffer while paused.
// It must enter warming too, rather than waiting on a permanently paused tile.
{
  const v=video({time:0,buffered:5,transport:'native'});v.paused=true;
  v.parentElement.dataset.playbackRate='16';
  const ctx=setup([v]);ctx.S.currentTime=100;ctx.S.speed=16;
  ctx.enterBufferingBarrier(null,null);assert.equal(v.dataset.warming,'0');
  v.buffered={length:1,start:()=>0,end:()=>1.991};
  let now=1000;ctx.performance.now=()=>now;
  ctx.warmNativeBuffer(v);assert.equal(v.dataset.warming,'1');
  assert.equal(v.plays,0,'hold the partial fragment while preloading');
  now+=1001;ctx.warmNativeBuffer(v);
  assert.equal(v.playbackRate,1);assert.ok(v.plays>0);
}

// beta.13 physical trace: Native stalls 84ms from the measured end while
// reporting HAVE_CURRENT_DATA, NETWORK_LOADING and a complete buffered tail.
{
  const tail=video({time:187.822038806,transport:'native'});
  tail.duration=187.906;tail.networkState=2;tail.readyState=2;
  tail.parentElement.dataset.duration='187.939';
  tail.buffered={length:1,start:()=>154.04090415,end:()=>187.905};
  const ctx=setup([tail]);ctx.S.currentTime=287.822038806;
  ctx.S.speed=16;ctx.S.activeTab='timeline';
  assert.equal(ctx.videoHasPlaybackBuffer(tail),false,
    'a retained tail frame is not evidence the decoder can resume');
  let now=1000;ctx.performance.now=()=>now;
  assert.equal(ctx.videoReachedEnd(tail),false);
  now+=1499;assert.equal(ctx.videoReachedEnd(tail),false);
  now++;assert.equal(ctx.videoReachedEnd(tail),true,
    'complete stable Native tail must transition even with NETWORK_LOADING');
}

// Do not infer EOF from an interrupted/growing tail or from a live HLS buffer.
for (const state of ['partial','gap','smallGap','growingDuration','growingBuffer','futureData','hls','seeking','unplayed','middle']) {
  const tail=video({time:187.822038806,transport:'native'});
  tail.duration=187.906;tail.networkState=2;tail.readyState=2;
  tail.parentElement.dataset.duration='187.939';
  let end=187.905;
  tail.buffered={length:1,start:()=>state==='gap'?187.88:state==='smallGap'?187.84:154,end:()=>end};
  const ctx=setup([tail]);let now=1000;ctx.performance.now=()=>now;
  ctx.videoReachedEnd(tail);
  if(state==='partial')end=187.85;
  if(state==='growingDuration')tail.duration=188.1;
  if(state==='growingBuffer')end=187.906;
  if(state==='futureData')tail.readyState=3;
  if(state==='hls')tail.parentElement.dataset.streamTransport='hls';
  if(state==='seeking')tail.seeking=true;
  if(state==='unplayed')tail.dataset.hasPlayed='0';
  if(state==='middle')tail.currentTime=185;
  now+=2000;
  assert.equal(ctx.videoReachedEnd(tail),false,state);
  if(['partial','gap','smallGap','hls','seeking','unplayed','middle','futureData'].includes(state)) {
    now+=2000;assert.equal(ctx.videoReachedEnd(tail),false,state+' persists');
  }
}

// Replay waiting/pause synchronously across clock ticks. Recovery must not be
// renewed every frame, and completion must use the normal next-file transition.
{
  const tail=video({time:187.822038806,transport:'native'});
  tail.duration=187.906;tail.networkState=2;tail.readyState=2;tail.paused=true;
  tail.parentElement.dataset.duration='187.939';
  tail.buffered={length:1,start:()=>154.04090415,end:()=>187.905};
  const ctx=setup([tail]);let now=1000;ctx.performance.now=()=>now;
  ctx.S.currentTime=287.822038806;ctx.S.speed=16;ctx.S.activeTab='timeline';
  ctx.requestAnimationFrame=()=>1;
  ctx.updatePlaybackUi=ctx.updateAutoHotspot=ctx.revealFreezeOnNextFrame=ctx.reconcilePlaybackPosition=()=>{};
  tail.pause=function(){this.paused=true;this.pauses++;};
  tail.play=function(){this.paused=false;this.plays++;ctx.enterBufferingBarrier(this,'buffering');return Promise.resolve();};
  ctx.onVideoEnded=()=>{ctx.completed=true;tail.hidden=true;ctx.S.currentTime=287.94;};
  ctx.enterBufferingBarrier(tail,'buffering');
  const started=vm.runInContext('_recoveryStarted',ctx);
  for(let tick=0;tick<89;tick++) {now=1000+tick*1000/60;ctx.clockTick();}
  assert.equal(vm.runInContext('_recoveryStarted',ctx),started);
  assert.ok(tail.plays<=2,'waiting must not cause repeated Play attempts');
  now=2501;ctx.clockTick();
  assert.equal(ctx.completed,true);
  assert.equal(tail.parentElement.dataset.failed,undefined,'normal EOF is not a broken recording');
}

// Tail stability belongs to the active source and actual playback, not to time
// spent paused or a previous recording with the same measured duration.
{
  const tail=video({time:187.822038806,transport:'native'});
  tail.duration=187.906;tail.readyState=2;tail.networkState=2;
  tail.parentElement.dataset.duration='187.939';
  tail.buffered={length:1,start:()=>154,end:()=>187.905};
  const ctx=setup([tail]);let now=1000;ctx.performance.now=()=>now;
  ctx.videoReachedEnd(tail);now+=1500;assert.equal(ctx.videoReachedEnd(tail),true);
  tail._generation=2;assert.equal(ctx.videoReachedEnd(tail),false);
  now+=1500;assert.equal(ctx.videoReachedEnd(tail),true);
  ctx.S.playing=false;ctx.videoReachedEnd(tail);now+=5000;
  ctx.S.playing=true;assert.equal(ctx.videoReachedEnd(tail),false);
}

// Freeze a recovered Native decoder at the requested position while another
// tile is still loading. Warming must not consume its buffered target.
{
  const v=video({time:15,buffered:40,transport:'native'});
  v.dataset.warming='1';v.paused=false;v.parentElement.dataset.playbackRate='16';
  v.pause=function(){this.pauses++;this.paused=true;};
  const ctx=setup([v]);ctx.S.speed=16;ctx.S.currentTime=110;
  v.buffered={length:1,start:()=>0,end:()=>55};
  vm.runInContext('_wasBuffering=true;',ctx);
  ctx.warmNativeBuffer(v);
  assert.equal(v.pauses,1);
  assert.equal(v.currentTime,10);
  assert.equal(ctx.S.currentTime,110);
  for(let i=0;i<120;i++)ctx.warmNativeBuffer(v);
  assert.equal(v.plays,0,'a ready held decoder must not keep warming');
  assert.equal(v.pauses,1);
}
// A completed seek that leaves the recovery target outside the buffer needs
// a fresh source read, once per target/epoch, with the same clock and deadline.
{
  const v=video({time:10,transport:'native'});v.dataset.warming='1';
  v.parentElement.dataset.playbackRate='16';v.paused=false;
  v.buffered={length:1,start:()=>11,end:()=>50};
  const ctx=setup([v]);ctx.S.speed=16;ctx.S.currentTime=110;
  const reloads=[];ctx.reloadNativeRecovery=(v,target)=>{reloads.push(target);return true;};
  vm.runInContext('_wasBuffering=true;_recoveryStarted=500;',ctx);
  ctx.warmNativeBuffer(v);assert.equal(v.currentTime,10);
  v.currentTime=12;ctx.warmNativeBuffer(v);
  assert.deepEqual(reloads,[10]);
  assert.equal(ctx.S.currentTime,110);assert.equal(vm.runInContext('_recoveryStarted',ctx),500);
  v.seeking=true;ctx.warmNativeBuffer(v);assert.equal(reloads.length,1);
}

// A source with target data remains eligible when another source exhausts
// recovery. A pending seek or missing target still cannot claim readiness.
{
  const v=video({time:35,transport:'native'});v.dataset.warming='1';
  v.parentElement.dataset.playbackRate='16';
  v.buffered={length:1,start:()=>10,end:()=>55};
  const ctx=setup([v]);ctx.S.speed=16;
  vm.runInContext('_wasBuffering=true;',ctx);
  assert.equal(ctx.recoveryVideoFailed(v),false);
  v.buffered={length:1,start:()=>11,end:()=>55};
  assert.equal(ctx.recoveryVideoFailed(v),true);
  v.buffered={length:1,start:()=>10,end:()=>55};v.seeking=true;
  assert.equal(ctx.recoveryVideoFailed(v),true);
}
// Source reload is bounded across source generations and keeps the deadline.
{
 const v=video({time:12,transport:'native'});v.parentElement.dataset.cam='1';
 const ctx=setup([v]);ctx.S.cameras=[{id:1}];
 ctx.findRecordingAt=()=>({id:1});let loads=0;
 ctx.updatePlayerCell=()=>{loads++;v._generation=(v._generation||0)+1;};
 vm.runInContext('_wasBuffering=true;_recoveryStarted=300;',ctx);
 assert.equal(ctx.reloadNativeRecovery(v,10),true);
 assert.equal(ctx.reloadNativeRecovery(v,10),false);assert.equal(loads,1);
 assert.equal(ctx.S.currentTime,110);assert.equal(vm.runInContext('_recoveryStarted',ctx),300);
 assert.equal(v.dataset.warming,'1');assert.equal(v.playbackRate,1);
 ctx.findRecordingAt=()=>({id:2});assert.equal(ctx.reloadNativeRecovery(v,11),false);
}

// Expiring one source's deadline must preserve and align the healthy source,
// including a seek that remains asynchronous after the failed tile is removed.
{
  const broken=video({time:20,transport:'native'});
  const healthy=video({time:35,transport:'native'});
  broken.buffered={length:1,start:()=>20,end:()=>55};
  healthy.buffered={length:1,start:()=>0,end:()=>55};
  healthy.dataset.recording='2';healthy.parentElement.dataset.recording='2';
  broken.dataset.warming=healthy.dataset.warming='1';
  const ctx=setup([broken,healthy]);ctx.S.activeTab='timeline';
  ctx.performance.now=()=>31001;ctx.requestAnimationFrame=()=>1;
  let media=35;Object.defineProperty(healthy,'currentTime',{
    get:()=>media,set:value=>{media=value;healthy.seeking=true;},
  });
  vm.runInContext('_wasBuffering=true;_recoveryStarted=100;',ctx);
  ctx.clockTick();
  assert.equal(broken.hidden,true);
  assert.equal(healthy.hidden,false);
  assert.equal(healthy.parentElement.dataset.failed,undefined);
  assert.equal(healthy.currentTime,10);
  assert.equal(ctx.S.currentTime,110);
  assert.equal(vm.runInContext('_recoveryStarted',ctx),31001);
}

// Preserve a decoded initial fragment even when it is below the 16x resume
// threshold. Preparing more data must not consume the requested first frame.
{
  const v=video({time:0.02,transport:'native'});v.parentElement.dataset.start='100';v.parentElement.dataset.playbackRate='16';
  v.buffered={length:1,start:()=>0,end:()=>1.99};v.dataset.warming='1';v.paused=false;
  v.pause=function(){this.paused=true;this.pauses++;};
  const ctx=setup([v]);ctx.S.currentTime=100.001;ctx.S.speed=16;
  vm.runInContext('_wasBuffering=true;',ctx);ctx.warmNativeBuffer(v);
  assert.equal(v.paused,true,'retain a partial target buffer rather than consuming it at 1x');
  assert.equal(ctx.videoHasPlaybackBuffer(v),false,'do not lower the 16x resume threshold');
  assert.equal(v.plays,0);assert.equal(ctx.S.currentTime,100.001);
}

// A held fragment whose download stops can request a play handshake at the
// a short pulse; growth returns it to hold, without a seek/Play storm.
{
  const v=video({time:0,transport:'native'});v.parentElement.dataset.playbackRate='16';
  let end=2,now=1000;v.buffered={length:1,start:()=>0,end:()=>end};
  v.pause=function(){this.paused=true;this.pauses++;};v.play=function(){this.paused=false;this.plays++;return Promise.resolve();};
  const ctx=setup([v]);ctx.performance.now=()=>now;ctx.S.currentTime=100;ctx.S.speed=16;
  vm.runInContext('_wasBuffering=true;_recoveryStarted=500;',ctx);
  ctx.warmNativeBuffer(v);assert.equal(v.paused,true);
  now=1900;ctx.warmNativeBuffer(v);assert.equal(v.plays,0);
  now=2001;ctx.warmNativeBuffer(v);assert.equal(v.plays,1);assert.equal(v.playbackRate,1);
  for(let i=0;i<60;i++){now+=16;ctx.warmNativeBuffer(v);}assert.equal(v.plays,1);
  end=3;ctx.warmNativeBuffer(v);assert.equal(v.paused,true);
  assert.equal(ctx.videoHasPlaybackBuffer(v),false);
  end=10;ctx.warmNativeBuffer(v);assert.equal(ctx.videoHasPlaybackBuffer(v),true);
  assert.equal(ctx.S.currentTime,100);assert.equal(vm.runInContext('_recoveryStarted',ctx),500);
  v._generation=2;end=2;ctx.warmNativeBuffer(v);
  assert.equal(v._nativeBufferPreparation.mode,'hold','a replacement source starts its own preparation');
}

// A pause that reduces the browser's exposed buffer must not cause endless
// prime/pause cycles. Keep actual streaming readiness, rather than caching a
// stale full range or weakening the accelerated resume requirement.
{
  const v=video({time:0,transport:'native'});v.parentElement.dataset.playbackRate='16';
  v.dataset.warming='1';v.paused=false;
  v.pause=function(){this.paused=true;this.pauses++;};v.play=function(){this.paused=false;this.plays++;return Promise.resolve();};
  Object.defineProperty(v,'buffered',{get:()=>({length:1,start:()=>0,end:()=>v.paused?2:20})});
  const ctx=setup([v]);ctx.S.currentTime=100;ctx.S.speed=16;
  vm.runInContext('_wasBuffering=true;_recoveryStarted=500;',ctx);
  ctx.warmNativeBuffer(v);
  assert.equal(v._nativeBufferPreparation.mode,'flow');assert.equal(v.paused,false);
  for(let i=0;i<120;i++)ctx.warmNativeBuffer(v);
  assert.equal(v.pauses,1);assert.equal(v.plays,1);
  assert.equal(ctx.videoHasPlaybackBuffer(v),true);assert.equal(v.playbackRate,1);
  assert.equal(ctx.S.currentTime,100);assert.equal(vm.runInContext('_recoveryStarted',ctx),500);
}

// Buffered startup drift holds only the leading Native decoder. The slower
// decoder's pending Play remains alive; catching up releases the leader.
{
 const lead=video({time:11,buffered:20,transport:'native'});
 const lag=video({time:10,buffered:20,transport:'native'});
 const ctx=setup([lead,lag]);ctx.revealFreezeOnNextFrame=()=>{};
 const items=()=>[{video:lead,time:100+lead.currentTime},{video:lag,time:100+lag.currentTime}];
 assert.equal(ctx.synchronizeNativeProgress(items(),0.6),true);
 assert.equal(lead.dataset.syncHeld,'1');assert.equal(lead.pauses,1);assert.equal(lag.pauses,0);
 for(let i=0;i<60;i++)ctx.synchronizeNativeProgress(items(),0.6);
 assert.equal(lead.pauses,1);assert.equal(lag.plays,0);
 lag.currentTime=10.9;assert.equal(ctx.synchronizeNativeProgress(items(),0.6),false);
 assert.equal(lead.dataset.syncHeld,'0');assert.equal(lead.plays,1);
 assert.equal(lead.defaultPlaybackRate,ctx.videoPlaybackRate(lead));
 lag.parentElement.dataset.streamTransport='hls';lead.currentTime=12;
 assert.equal(ctx.synchronizeNativeProgress(items(),0.6),false,'compressed transports retain their synchronization policy');
}

// Future data alone does not prove that a cold Native decoder has started.
// Keep its preparation running until real media progress, then hold without
// immediately undoing that startup through a redundant tiny seek.
{
 const v=video({time:0,buffered:20,transport:'native'});v.readyState=3;v.dataset.warming='1';
 v.parentElement.dataset.playbackRate='16';v.paused=true;
 v.pause=function(){this.paused=true;this.pauses++;};v.play=function(){this.paused=false;this.plays++;return Promise.resolve();};
 const ctx=setup([v]);ctx.S.currentTime=100;ctx.S.speed=16;
 vm.runInContext('_wasBuffering=true;',ctx);
 assert.equal(ctx.nativeRecoveryTargetReady(v),false);ctx.warmNativeBuffer(v);
 assert.equal(v.paused,false);assert.equal(v.pauses,0);
 v.currentTime=0.03;ctx.warmNativeBuffer(v);assert.equal(v.pauses,0);
 v.currentTime=0.06;ctx.warmNativeBuffer(v);assert.equal(v.paused,true);
 assert.equal(v.currentTime,0.06);assert.equal(ctx.nativeRecoveryTargetReady(v),true);
 assert.equal(ctx.S.currentTime,100);
}

// Download progress on a partial Native source is not a decoder/file failure.
// An evicted target or thirty seconds without new data still exhausts recovery.
{
 const v=video({time:0,transport:'native'});v.readyState=3;v.networkState=2;
 let end=5,now=1000;v.buffered={length:1,start:()=>0,end:()=>end};
 const ctx=setup([v]);ctx.S.currentTime=100;ctx.performance.now=()=>now;
 ctx.trackNativeDelivery(v);assert.equal(ctx.nativeDeliveryActive(v),true);
 now=20000;end=10;ctx.trackNativeDelivery(v);now=40000;
 assert.equal(ctx.nativeDeliveryActive(v),true);
 end=5;ctx.trackNativeDelivery(v);end=10;ctx.trackNativeDelivery(v);
 now=50001;assert.equal(ctx.nativeDeliveryActive(v),false,'seeks cannot renew delivery idle time');
 now=51000;end=12;ctx.trackNativeDelivery(v);
 v.buffered={length:1,start:()=>1,end:()=>12};assert.equal(ctx.nativeDeliveryActive(v),false,'a missing target cannot hide behind forward delivery');
 v.buffered={length:1,start:()=>0,end:()=>12};v.readyState=4;
 assert.equal(ctx.nativeDeliveryActive(v),false,'buffered decoder freezes still use their recovery limit');
}

// The previous source can briefly retain readyState and ranges during load.
// Metadata readiness belongs to the new source before it can claim readiness.
{
 const v=video({buffered:20,transport:'native'});v.dataset.metadataReady='0';
 const ctx=setup([v]);assert.equal(ctx.videoHasPlaybackBuffer(v),false);
 assert.equal(ctx.nativeRecoveryTargetReady(v),false);assert.equal(ctx.selectedFrameReady(v),false);
 v.dataset.metadataReady='1';assert.equal(ctx.videoHasPlaybackBuffer(v),true);
}

// A generation-guarded progress signal covers bytes not yet exposed as decoded
// ranges. A stale source, idle load, error or missing decoded target cannot use it.
{
 const v=video({time:0,transport:'native'});v._generation=2;v.networkState=2;v.readyState=1;
 v.buffered={length:0};v._nativeLoadProgress={generation:2,wall:1000};
 const ctx=setup([v]);ctx.S.currentTime=100;let now=2000;ctx.performance.now=()=>now;
 assert.equal(ctx.nativeDeliveryActive(v),true);
 v._nativeLoadProgress.generation=1;assert.equal(ctx.nativeDeliveryActive(v),false);
 v._nativeLoadProgress.generation=2;now=31001;assert.equal(ctx.nativeDeliveryActive(v),false);
 now=32000;v._nativeLoadProgress.wall=31900;v.readyState=3;
 v.buffered={length:1,start:()=>0,end:()=>8};assert.equal(ctx.nativeDeliveryActive(v),true);
 v.buffered={length:1,start:()=>1,end:()=>8};assert.equal(ctx.nativeDeliveryActive(v),false);
 v.error={code:3};assert.equal(ctx.nativeDeliveryActive(v),false);
}

// A proven buffered Native decoder freeze gets one guarded source restart
// before exclusion. The original monitor threshold and clock stay unchanged.
{
 const v=video({buffered:20,transport:'native'});v.parentElement.dataset.cam='1';
 const ctx=setup([v]);let now=1000,reloads=0;ctx.performance.now=()=>now;
 ctx.reloadNativeRecovery=()=>++reloads===1;
 ctx.checkVideoProgress(v);now=9001;ctx.checkVideoProgress(v);
 assert.equal(reloads,1);assert.equal(v.hidden,false);assert.equal(ctx.S.currentTime,110);
 vm.runInContext('_wasBuffering=false;_recoveryStarted=null;',ctx);
 ctx.checkVideoProgress(v);now=18002;ctx.checkVideoProgress(v);
 assert.equal(reloads,2);assert.equal(v.hidden,true);
}

// A transient Native decode error gets one fresh source per recording/epoch,
// including simultaneous errors on different cameras. Never renew a deadline.
{
  const v=video({buffered:20,transport:'native'});v.parentElement.dataset.cam='1';
  const ctx=setup([v]);ctx.S.cameras=[{id:1}];ctx.findRecordingAt=()=>({id:1});
  let loads=0;ctx.updatePlayerCell=()=>{loads++;v._generation=(v._generation||0)+1;};
  vm.runInContext('_wasBuffering=true;_recoveryStarted=300;',ctx);
  assert.equal(ctx.retryNativeDecodeError(v,{code:3}),true);
  assert.equal(loads,1);assert.equal(ctx.S.currentTime,110);
  assert.equal(vm.runInContext('_recoveryStarted',ctx),300);
  assert.equal(ctx.retryNativeDecodeError(v,{code:3}),false);
  ctx.failVideo(v);assert.equal(v.hidden,true);assert.equal(ctx.S.playing,true);
}
for(const [transport,code,playing,expired] of [
  ['native',2,true,false],['native',4,true,false],['mp4',3,true,false],
  ['hls',3,true,false],['native',3,false,false],['native',3,true,true]]) {
  const v=video({buffered:20,transport});v.parentElement.dataset.cam='1';
  const ctx=setup([v]);ctx.S.playing=playing;ctx.S.cameras=[{id:1}];
  ctx.findRecordingAt=()=>({id:1});ctx.updatePlayerCell=()=>assert.fail('unexpected retry');
  if(expired)vm.runInContext('_recoveryStarted=-30000;',ctx);
  assert.equal(ctx.retryNativeDecodeError(v,{code}),false);
}

// Decoded-frame delivery stops a warming pulse before a coarse player tick can
// consume the fragment. Late callbacks from a replaced source cannot pause it.
{
  const v=video({time:0,transport:'native'});v.parentElement.dataset.playbackRate='16';
  v.buffered={length:1,start:()=>0,end:()=>2};let frame,now=1000;
  v.requestVideoFrameCallback=fn=>{frame=fn;return 1;};
  v.pause=function(){this.paused=true;this.pauses++;};
  v.play=function(){this.paused=false;this.plays++;return Promise.resolve();};
  const ctx=setup([v]);ctx.S.currentTime=100;ctx.S.speed=16;ctx.performance.now=()=>now;
  vm.runInContext('_wasBuffering=true;_recoveryStarted=500;',ctx);
  ctx.warmNativeBuffer(v);now=2001;ctx.warmNativeBuffer(v);
  assert.equal(v.paused,false);v.currentTime=.033;frame();
  assert.equal(v.paused,true);assert.equal(v._nativeBufferPreparation.mode,'hold');
  assert.equal(ctx.S.currentTime,100);assert.equal(vm.runInContext('_recoveryStarted',ctx),500);
  now=3002;ctx.warmNativeBuffer(v);assert.equal(v.paused,true,'no repeated pulse without new buffer growth');
  v.buffered={length:1,start:()=>0,end:()=>3};ctx.warmNativeBuffer(v);
  now=4003;ctx.warmNativeBuffer(v);const late=frame;v._generation=2;
  late();assert.equal(v.paused,false,'ignore callback from the old source');
}

// Post-seek prefetch with a present target and a completed pulse can stall.
// Reopen once across replacement generations without moving the clock/deadline.
{
  const v=video({time:10.015,transport:'native'});v._generation=7;v.paused=true;
  v.parentElement.dataset.cam='1';v.parentElement.dataset.playbackRate='16';
  v.buffered={length:1,start:()=>10,end:()=>11.933};
  v._nativePrefetchSeek={key:'0:7:10',wall:1000};
  v._nativeBufferPreparation={key:'0:7:10',ahead:1.933,changed:1500,mode:'hold',primedAhead:1.933};
  v._nativeLoadProgress={generation:7,wall:1300};
  const ctx=setup([v]);ctx.S.speed=16;ctx.S.cameras=[{id:1}];ctx.findRecordingAt=()=>({id:1});
  let now=6499,loads=0;ctx.performance.now=()=>now;
  ctx.updatePlayerCell=()=>{loads++;v._generation++;};
  vm.runInContext('_wasBuffering=true;_recoveryStarted=500;',ctx);
  assert.equal(ctx.recoverStalledNativePrefetch(v,10),false);
  now=6500;ctx.warmNativeBuffer(v);assert.equal(loads,1);
  assert.equal(ctx.S.currentTime,110);assert.equal(vm.runInContext('_recoveryStarted',ctx),500);
  v._nativePrefetchSeek={key:'0:8:10',wall:6500};
  v._nativeBufferPreparation={key:'0:8:10',ahead:1.933,changed:6500,mode:'hold',primedAhead:1.933};
  now=12000;assert.equal(ctx.recoverStalledNativePrefetch(v,10),false);
  assert.equal(loads,1,'a permanently stalled replacement cannot loop');
}
for(const guard of ['progress','bufferGrowth','noSeek','oldSeek','noPulse','seeking','playing',
                    'enoughData','missingTarget','expired','mp4','hls','newEpoch']) {
  const v=video({time:10.015,transport:'native'});v._generation=7;v.paused=true;
  v.parentElement.dataset.playbackRate='16';v.buffered={length:1,start:()=>10,end:()=>11.933};
  v._nativePrefetchSeek={key:'0:7:10',wall:1000};
  v._nativeBufferPreparation={key:'0:7:10',ahead:1.933,changed:1500,mode:'hold',primedAhead:1.933};
  const ctx=setup([v]);ctx.S.speed=16;ctx.performance.now=()=>10000;
  ctx.reloadNativeRecovery=()=>assert.fail(`unexpected reload: ${guard}`);
  vm.runInContext('_wasBuffering=true;_recoveryStarted=500;',ctx);
  if(guard==='progress')v._nativeLoadProgress={generation:7,wall:9500};
  if(guard==='bufferGrowth')v.buffered={length:1,start:()=>10,end:()=>12.1};
  if(guard==='noSeek')v._nativePrefetchSeek=null;
  if(guard==='oldSeek')v._nativePrefetchSeek.key='0:6:10';
  if(guard==='noPulse')delete v._nativeBufferPreparation.primedAhead;
  if(guard==='seeking')v.seeking=true;
  if(guard==='playing')v.paused=false;
  if(guard==='enoughData')v.buffered={length:1,start:()=>10,end:()=>20};
  if(guard==='missingTarget')v.buffered={length:1,start:()=>11,end:()=>20};
  if(guard==='expired')vm.runInContext('_recoveryStarted=-21000;',ctx);
  if(['mp4','hls'].includes(guard))v.parentElement.dataset.streamTransport=guard;
  if(guard==='newEpoch')vm.runInContext('_playbackEpoch++;',ctx);
  assert.equal(ctx.recoverStalledNativePrefetch(v,10),false,guard);
}

// HLS alignment seeks must keep decoding while the global clock is held.
{
  const hls = video({transport:'hls', buffered:5});
  const ctx = setup([hls]);
  ctx.S.currentTime = 112;
  vm.runInContext('_wasBuffering = true', ctx);
  ctx.seekVideo(hls);
  assert.equal(hls.currentTime, 12);
  assert.equal(hls.muted, true);
  assert.equal(hls.dataset.warming, '1');
  assert.equal(hls.plays, 1);
}
