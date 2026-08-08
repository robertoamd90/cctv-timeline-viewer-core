const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  safeSeekTarget,
  playbackCompleted,
  requiredPlaybackBuffer,
  timelinePlaybackSpeed,
  playbackPlan,
  transcodedTailHasFrame,
  recordingAt,
  latestRecordingAt,
  lastSegmentStartingBetween,
  overlappingSegments,
  mediaTimeForTimeline,
  timelineTimeForMedia,
  medianTime,
} = require('../ctv_web/js/media.js');
const playerSource = fs.readFileSync(require.resolve('../ctv_web/js/player.js'), 'utf8');
const timelineSource = fs.readFileSync(require.resolve('../ctv_web/js/timeline.js'), 'utf8');

assert.equal(medianTime([]), null);
assert.equal(medianTime([12]), 12);
assert.equal(medianTime([14, 10, 12]), 12);
assert.equal(medianTime([14, 10, 12, 20]), 13);
assert.equal(medianTime([NaN, 12, Infinity, 14]), 13);

assert.equal(safeSeekTarget(110, 100, NaN), 10);
assert.equal(safeSeekTarget(110, 100, 8), 7.95);
assert.equal(safeSeekTarget(90, 100, 8), 0);

assert.equal(playbackCompleted({
  ended: true, currentTime: 0, expectedDuration: 10, metadataReady: true, hasPlayed: false,
}), false, 'an early ended event must not skip an unplayed clip');
assert.equal(playbackCompleted({
  ended: true, currentTime: 4, expectedDuration: 10, metadataReady: true, hasPlayed: true,
}), false, 'an ended event before the media duration must be treated as interrupted loading');
assert.equal(playbackCompleted({
  ended: false, currentTime: 9.9, expectedDuration: 10, metadataReady: false, hasPlayed: true,
}), false, 'completion requires reliable metadata');
assert.equal(playbackCompleted({
  ended: true, currentTime: 10, expectedDuration: 10, metadataReady: true, hasPlayed: true,
}), true);
assert.equal(playbackCompleted({
  ended: false, currentTime: 9.9, expectedDuration: 10, metadataReady: true, hasPlayed: true,
}), false, 'a growing Firefox duration must not be interpreted as a completed clip');
assert.equal(playbackCompleted({
  ended: true, currentTime: 10, expectedDuration: 10, metadataReady: true, hasPlayed: true,
  buffering: true,
}), false, 'a clip ending inside the global buffering barrier must not advance the timeline');
assert.equal(playbackCompleted({
  ended: true, currentTime: 10, expectedDuration: 10, metadataReady: true, hasPlayed: true,
  warming: true,
}), false, 'a warm-up playback must not advance the timeline');

assert.equal(requiredPlaybackBuffer(16, 10, 30), 4);
assert.equal(requiredPlaybackBuffer(16, 26, 30), 3.5);
assert.equal(requiredPlaybackBuffer(16, 29.7, 30), 0);
assert.equal(requiredPlaybackBuffer(1, 10, NaN), 0.75);
assert.equal(timelinePlaybackSpeed(1, 16), 16);
assert.equal(timelinePlaybackSpeed(8, 1), 8);
assert.equal(timelinePlaybackSpeed(NaN, NaN), 1);

assert.deepEqual(playbackPlan('native', 16), {
  transcoded: false, streamSpeed: 1, playbackRate: 16,
});
assert.deepEqual(playbackPlan('balanced', 16), {
  transcoded: true, streamSpeed: 16, playbackRate: 1,
});
assert.deepEqual(playbackPlan('fast', 0.5), {
  transcoded: true, streamSpeed: 1, playbackRate: 0.5,
});
assert.equal(transcodedTailHasFrame(2.5, 16, 15), true);
assert.equal(
  transcodedTailHasFrame(0.2, 16, 15),
  false,
  'a transcoded tail too short to produce one output frame must be skipped',
);
assert.equal(transcodedTailHasFrame(1, 8, 8), true);
const orderedSegments = Array.from({length: 10000}, (_, index) => ({
  id: index,
  start_ts: index * 10,
  end_ts: index * 10 + 5,
}));
assert.equal(recordingAt(orderedSegments, 54321).id, 5432);
assert.equal(recordingAt(orderedSegments, 54326), null);
assert.equal(recordingAt(orderedSegments, -1), null);
assert.equal(recordingAt([], 10), null);
const overlapping = [
  {id: 'long', start_ts: 0, end_ts: 100},
  {id: 'short', start_ts: 10, end_ts: 20},
  {id: 'point', start_ts: 30, end_ts: null},
  {id: 'late', start_ts: 200, end_ts: 210},
];
assert.deepEqual(overlappingSegments(overlapping, 12, 15).map(segment => segment.id), ['long', 'short']);
assert.deepEqual(overlappingSegments(overlapping, 30, 30).map(segment => segment.id), ['long', 'point']);
assert.deepEqual(overlappingSegments(overlapping, 31, 40).map(segment => segment.id), ['long']);
assert.equal(latestRecordingAt(overlapping, 15).id, 'short');
assert.equal(latestRecordingAt(overlapping, 50).id, 'point');
assert.equal(latestRecordingAt(overlapping, 150).id, 'point');
assert.equal(lastSegmentStartingBetween(overlapping, 9, 30).id, 'point');
const unsortedOverlapping = [overlapping[3], overlapping[0], overlapping[1]];
assert.deepEqual(
  overlappingSegments(unsortedOverlapping, 12, 15).map(segment => segment.id),
  ['long', 'short'],
);
assert.equal(latestRecordingAt(unsortedOverlapping, 15).id, 'short');
assert.equal(mediaTimeForTimeline(130, 100, 10, 4, 20), 5);
assert.equal(timelineTimeForMedia(5, 100, 10, 4), 130);

assert.match(playerSource, /preload="metadata"/);
assert.match(playerSource, /v\.preload = S\.preloadMode/);
assert.match(playerSource, /readyState < HTMLMediaElement\.HAVE_CURRENT_DATA/);
assert.match(playerSource, /target > 0\.05/);
assert.match(playerSource, /streamTransport === 'mp4'\) return true/);
assert(playerSource.includes('/stream/${rec.id}'));
assert(playerSource.includes("canPlayType('application/vnd.apple.mpegurl')"));
assert.match(playerSource, /navigator\.maxTouchPoints > 0/);
assert.match(playerSource, /if \(!mobilePlayback\) return false/);
assert(playerSource.includes('/hls/${streamSessionId()}/index.m3u8'));
assert.match(playerSource, /requiredPlaybackBuffer\(videoPlaybackRate\(video\)/);
assert.match(playerSource, /transcodedTailHasFrame/);
assert.match(playerSource, /CtvMedia\.recordingAt/);
assert.match(playerSource, /const completed = _wasBuffering \? null/);
assert.match(
  playerSource,
  /streamTransport === 'mp4' && v\.ended[\s\S]*?onVideoEnded\(v, recId\)/,
  'a completed progressive warm-up stream must not be replayed from zero',
);
assert.match(playerSource, /S\.speed = speed;\s+_clockStartTime = S\.currentTime/);
assert.match(playerSource, /dataset\.playbackRate = String\(S\.speed\)/);
assert.match(playerSource, /speedSelect\.addEventListener\('input'/);
assert.match(playerSource, /S\.playing && requiresWarmup/);
assert.match(
  playerSource,
  /streamTransport !== 'mp4'[\s\S]*?target > 0\.1 && remaining > 0\.5/,
  'a progressive stream must be reopened at the global time instead of sought in place',
);
assert.match(
  playerSource,
  /streamTransport === 'mp4'[\s\S]*?if \(remaining <= 0\.5\) return;[\s\S]*?restartProgressiveVideo\(video\)/,
  'progressive stream alignment must not seek in place',
);
assert.match(
  playerSource,
  /const keepHlsWarming = v\.dataset\.warming === '1'[\s\S]*?if \(!keepHlsWarming\) v\.pause\(\)/,
  'only HLS streams must advance behind the freeze frame while warming',
);
assert.match(playerSource, /ctv-preload-mode/);
assert.match(playerSource, /function updatePlaybackUi/);
assert.match(playerSource, /isCompactViewport\(\) \? 50 : 33/);
assert.match(timelineSource, /function updateOverviewPlayhead/);
assert.match(timelineSource, /CtvMedia\.overlappingSegments/);
assert.match(timelineSource, /_overviewBaseCache/);
assert.match(timelineSource, /body\.addEventListener\('mouseover'/);
const updateCursorSource = timelineSource.slice(
  timelineSource.indexOf('function updateCursor()'),
  timelineSource.indexOf('function updateOverviewPlayhead()'),
);
assert.doesNotMatch(
  updateCursorSource,
  /renderOverview\(/,
  'moving the playhead must not redraw every timeline segment',
);

console.log('Media state tests passed');
