const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const CtvMedia = require('../ctv_web/js/media.js');

function video({time = 10, buffered = 0, transport = 'mp4', played = true} = {}) {
  return {
    currentTime: time, readyState: 3, seeking: false, hidden: false,
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
// Warming must keep playback eligible at 1x without weakening the 4s threshold.
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
  ctx.warmNativeBuffer(v);
  assert.equal(v.dataset.warming,'1');assert.equal(v.playbackRate,1);assert.ok(v.plays>0);
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
