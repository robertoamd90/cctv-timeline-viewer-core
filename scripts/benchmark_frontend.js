#!/usr/bin/env node
/* Repeatable CPU benchmark for browser-independent timeline hot paths. */

const { performance } = require('node:perf_hooks');
const CtvMedia = require('../ctv_web/js/media.js');
const {
  hotspotStartCandidate,
  hotspotCurrentCandidate,
} = require('../ctv_web/js/hotspot.js');

const cameraCount = 8;
const segmentsPerCamera = 10000;
const cameras = Array.from({ length: cameraCount }, (_, cameraIndex) => ({
  camera_id: cameraIndex + 1,
  segments: Array.from({ length: segmentsPerCamera }, (_, segmentIndex) => {
    const start = segmentIndex * 10 + cameraIndex * 0.01;
    return { id: cameraIndex * segmentsPerCamera + segmentIndex, start_ts: start, end_ts: start + 6 };
  }),
}));
const visibleIds = cameras.map(camera => camera.camera_id);
const focusTime = 50005.5;

function measure(callable_, iterations) {
  let checksum = 0;
  for (let index = 0; index < Math.min(iterations, 20); index++) callable_();
  const started = performance.now();
  for (let index = 0; index < iterations; index++) {
    const result = callable_();
    checksum += Array.isArray(result) ? result.length : (result || 0);
  }
  return {
    total_ms: Number((performance.now() - started).toFixed(3)),
    iterations,
    checksum,
  };
}

const overlappingSegments = CtvMedia.overlappingSegments || ((segments, from, to) =>
  segments.filter(segment => (segment.end_ts || segment.start_ts) >= from && segment.start_ts <= to)
);

console.log(JSON.stringify({
  cameras: cameraCount,
  segments_per_camera: segmentsPerCamera,
  hotspot_current: measure(
    () => hotspotCurrentCandidate(cameras, visibleIds, focusTime), 500,
  ),
  hotspot_start: measure(
    () => hotspotStartCandidate(cameras, visibleIds, focusTime - 0.1, focusTime), 500,
  ),
  visible_window: measure(
    () => overlappingSegments(cameras[0].segments, focusTime - 60, focusTime + 60), 2000,
  ),
}, null, 2));
