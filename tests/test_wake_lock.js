const assert = require('assert');
const fs = require('fs');

const source = fs.readFileSync('ctv_web/js/player.js', 'utf8');
const fallback = fs.readFileSync('ctv_web/js/keep-awake-fallback.js', 'utf8');

assert.match(source, /navigator\.wakeLock\?\.request/);
assert.match(source, /navigator\.wakeLock\.request\('screen'\)/);
assert.match(source, /document\.addEventListener\('visibilitychange'/);
assert.match(source, /S\.playing = false;\s+void syncPlaybackWakeLock\(\);/);
assert.match(source, /S\.playing = true; updatePlayButton\(\);\s+void syncPlaybackWakeLock\(\);/);
assert.match(source, /iPhone\|iPad\|iPod/);
assert.match(source, /PlaybackKeepAwakeFallback/);
assert.match(fallback, /data:video\/mp4;base64,/);
assert.match(fallback, /getVideo\(\)\.play\(\)/);

console.log('Playback wake lock tests passed');
