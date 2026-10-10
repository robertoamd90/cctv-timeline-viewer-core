const assert = require('node:assert/strict');
require('../ctv_web/js/playback-trace.js');
const {boundedPush, videoState, errorText} = globalThis.CtvPlaybackTrace;

// The legacy helper is still bounded; persistent sessions do not use it.
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

// Session throughput survives eviction of old ring samples, excludes seeks,
// and separates browser suspension from measured stalls.
{
  const {accumulateSession}=globalThis.CtvPlaybackTrace;
  const totals={observedMs:0,playingMs:0,bufferingMs:0,stalledMs:0,timelineSeconds:0,discontinuities:0,unobservedMs:0};
  const point=(wall,time,extras={})=>({wall,time,playing:true,speed:16,hidden:false,buffering:false,...extras});
  accumulateSession(totals,point(0,0),point(1000,16));
  accumulateSession(totals,point(1000,16),point(2000,16,{buffering:true}));
  accumulateSession(totals,point(2000,16),point(3000,1000));
  accumulateSession(totals,point(3000,1000),point(20000,1016));
  accumulateSession(totals,point(20000,1016),point(21000,1032,{hidden:true}));
  assert.equal(totals.timelineSeconds,16);
  assert.equal(totals.playingMs,3000);
  assert.equal(totals.bufferingMs,1000);
  assert.equal(totals.stalledMs,1000);
  assert.equal(totals.discontinuities,1);
  assert.equal(totals.unobservedMs,18000);
}

// A 90-minute event storm retains one bucket per second, with exact counts,
// source generations and distinct transport routes. No five-minute rotation.
{
  const {EventBuckets}=globalThis.CtvPlaybackTrace;
  const chunks=[]; const buckets=new EventBuckets();
  for(let second=0;second<5400;second++) {
    for(let i=0;i<60;i++) buckets.add({wall:second*1000+i*16,type:'waiting',video:{camera:'3',recording:'1',generation:2}});
    if(second%5===4) chunks.push(buckets.drain());
  }
  const all=chunks.flat();
  assert.equal(all.length,5400);
  assert.equal(all[0].wall,0);
  assert.equal(all.at(-1).wall,5399000);
  assert.equal(all.reduce((n,e)=>n+e.count,0),324000);
  assert.equal(all[0].lastWall,944);
  buckets.add({wall:1,type:'resource',route:'native-video'});
  buckets.add({wall:2,type:'resource',route:'timeline'});
  buckets.add({wall:3,type:'waiting',video:{generation:3}});
  buckets.add({wall:4,type:'waiting',video:{generation:4}});
  assert.equal(buckets.drain().length,4);
}

{
  const buckets=new globalThis.CtvPlaybackTrace.EventBuckets();
  buckets.add({wall:1,type:'resource',route:'native-video',durationMs:10});
  buckets.add({wall:2,type:'resource',route:'native-video',durationMs:300});
  const [entry]=buckets.drain();
  assert.equal(entry.durationTotalMs,310);assert.equal(entry.durationMinMs,10);assert.equal(entry.durationMaxMs,300);
  let snapshots=0;
  for(let i=0;i<10000;i++) buckets.add({wall:i/10,type:'waiting'},()=>{snapshots++;return {state:'first'};});
  assert.equal(snapshots,1);
}
