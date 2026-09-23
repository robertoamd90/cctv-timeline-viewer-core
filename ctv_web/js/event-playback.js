/* Shared event semantics: whole-clip OR filtering and recorded-time badges. */
(function(root) {
  const kinds = ['person','vehicle','animal','motion','doorbell'];
  function eventEnd(event) {
    return Number.isFinite(event.end_timestamp) && event.end_timestamp > event.timestamp
      ? event.end_timestamp : event.timestamp + 3;
  }
  function filterTimeline(timeline, selected) {
    if (!timeline) return null;
    return {...timeline, cameras:timeline.cameras.map(camera => ({...camera,
      segments: selected.size ? camera.segments.filter(segment =>
        (segment.events || []).some(event => selected.has(event.type))) : camera.segments
    }))};
  }
  function activeTypes(events, timestamp) {
    return kinds.filter(kind => (events || []).some(event => event.type === kind &&
      event.timestamp <= timestamp && timestamp < eventEnd(event)));
  }
  function playableTime(timeline, cameraIds, time) {
    let next = Infinity;
    for (const camera of timeline?.cameras || []) {
      if (!cameraIds.includes(camera.camera_id)) continue;
      for (const segment of camera.segments) {
        if (segment.start_ts <= time && time < segment.end_ts) return time;
        if (segment.end_ts > segment.start_ts && segment.start_ts >= time) next = Math.min(next, segment.start_ts);
      }
    }
    return Number.isFinite(next) ? next : null;
  }
  root.CtvEventPlayback = {kinds,eventEnd,filterTimeline,activeTypes,playableTime};
})(typeof window === 'undefined' ? globalThis : window);
