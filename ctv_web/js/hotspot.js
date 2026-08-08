/* Pure ordering and event-selection helpers for Auto Hotspot. */

let _hotspotMediaApi = null;

function hotspotMediaApi() {
  if (_hotspotMediaApi) return _hotspotMediaApi;
  if (typeof CtvMedia !== 'undefined') _hotspotMediaApi = CtvMedia;
  else if (typeof require === 'function') _hotspotMediaApi = require('./media.js');
  return _hotspotMediaApi;
}

function hotspotPromotedOrder(order, cameraId, validIds) {
  const valid = new Set(validIds);
  const normalized = [
    ...order.filter(id => valid.has(id)),
    ...validIds.filter(id => !order.includes(id)),
  ];
  if (!valid.has(cameraId)) return normalized;
  return [cameraId, ...normalized.filter(id => id !== cameraId)];
}

function hotspotStartCandidate(cameras, visibleIds, fromExclusive, toInclusive) {
  if (fromExclusive == null || toInclusive == null || toInclusive < fromExclusive) return null;
  const visibleOrder = new Map(visibleIds.map((id, index) => [id, index]));
  const media = hotspotMediaApi();
  let candidate = null;
  cameras.forEach(camera => {
    if (!visibleOrder.has(camera.camera_id)) return;
    const segment = media.lastSegmentStartingBetween(
      camera.segments, fromExclusive, toInclusive,
    );
    if (!segment) return;
    const order = visibleOrder.get(camera.camera_id);
    if (!candidate || segment.start_ts > candidate.start ||
        (segment.start_ts === candidate.start && order < candidate.order)) {
      candidate = { cameraId: camera.camera_id, start: segment.start_ts, order };
    }
  });
  return candidate ? candidate.cameraId : null;
}

function hotspotCurrentCandidate(cameras, visibleIds, time) {
  if (time == null) return null;
  const visibleOrder = new Map(visibleIds.map((id, index) => [id, index]));
  const media = hotspotMediaApi();
  let candidate = null;
  cameras.forEach(camera => {
    if (!visibleOrder.has(camera.camera_id)) return;
    const segment = media.latestRecordingAt(camera.segments, time);
    if (!segment) return;
    const order = visibleOrder.get(camera.camera_id);
    if (!candidate || segment.start_ts > candidate.start ||
        (segment.start_ts === candidate.start && order < candidate.order)) {
      candidate = { cameraId: camera.camera_id, start: segment.start_ts, order };
    }
  });
  return candidate ? candidate.cameraId : null;
}

if (typeof module !== 'undefined') {
  module.exports = { hotspotPromotedOrder, hotspotStartCandidate, hotspotCurrentCandidate };
}
