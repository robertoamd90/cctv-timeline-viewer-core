const assert = require('node:assert/strict');
require('../ctv_web/js/playback-trace.js');
const {boundedPush, videoState, errorText} = globalThis.CtvPlaybackTrace;

// Long sessions retain a fixed amount of data, including bursts of media events.
const samples = [];
for (let i = 0; i < 10000; i++) boundedPush(samples, {wall:i}, 300);
assert.equal(samples.length, 300);
assert.equal(samples[0].wall, 9700);

// A trace must not expose authenticated URLs or the names/paths of sources.
assert.equal(errorText('Failed https://host/api/hassio_ingress/SECRET/video/123'), 'Failed [path]');
assert.equal(errorText('File /private/videos/Garage.mp4 failed'), 'File [path] failed');
assert.equal(errorText('x'.repeat(1000)).length, 500);
const video = {
  parentElement: {dataset:{cam:'2',streamTransport:'hls'}},
  dataset: {recording:'123',warming:'1'},
  src:'https://host/api/hassio_ingress/SECRET/video/123',
  currentTime:4, duration:Infinity, readyState:3, networkState:2,
  paused:false, seeking:true, ended:false, hidden:false,
  buffered:{length:1,start:()=>2,end:()=>6},
  getVideoPlaybackQuality:()=>({totalVideoFrames:60,droppedVideoFrames:2}),
};
const state = videoState(video);
assert.equal(state.duration, null);
assert.equal(state.frames, 60);
assert.equal(state.seeking, true);
assert.deepEqual(state.buffered, [[2,6]]);
assert(!JSON.stringify(state).includes('SECRET'));
assert(!('src' in state));
console.log('Playback trace tests passed');
