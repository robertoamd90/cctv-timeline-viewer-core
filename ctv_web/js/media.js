(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CtvMedia = api;
})(typeof window !== 'undefined' ? window : globalThis, function() {
  const intervalIndexes = new WeakMap();

  function upperBoundStart(segments, timestamp) {
    let low = 0;
    let high = segments.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (segments[middle].start_ts <= timestamp) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  function intervalIndex(segments) {
    const cached = intervalIndexes.get(segments);
    const first = segments[0];
    const last = segments[segments.length - 1];
    if (cached && cached.length === segments.length && cached.first === first && cached.last === last) {
      return cached;
    }
    let size = 1;
    while (size < segments.length) size <<= 1;
    const visibleMax = new Float64Array(size * 2);
    const activeMax = new Float64Array(size * 2);
    visibleMax.fill(-Infinity);
    activeMax.fill(-Infinity);
    let sorted = true;
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index];
      if (index && segment.start_ts < segments[index - 1].start_ts) sorted = false;
      visibleMax[size + index] = segment.end_ts || segment.start_ts;
      activeMax[size + index] = segment.end_ts == null ? Infinity : segment.end_ts;
    }
    for (let index = size - 1; index; index--) {
      visibleMax[index] = Math.max(visibleMax[index * 2], visibleMax[index * 2 + 1]);
      activeMax[index] = Math.max(activeMax[index * 2], activeMax[index * 2 + 1]);
    }
    const created = { length: segments.length, first, last, size, visibleMax, activeMax, sorted };
    intervalIndexes.set(segments, created);
    return created;
  }

  function collectOverlaps(index, segments, node, left, right, limit, from, result) {
    if (left > limit || index.visibleMax[node] < from) return;
    if (left === right) {
      if (left < segments.length) result.push(segments[left]);
      return;
    }
    const middle = (left + right) >> 1;
    collectOverlaps(index, segments, node * 2, left, middle, limit, from, result);
    if (middle < limit) {
      collectOverlaps(index, segments, node * 2 + 1, middle + 1, right, limit, from, result);
    }
  }

  function overlappingSegments(segments, from, to) {
    if (!segments.length || to < from) return [];
    const index = intervalIndex(segments);
    if (!index.sorted) {
      return segments.filter(segment =>
        (segment.end_ts || segment.start_ts) >= from && segment.start_ts <= to
      );
    }
    const limit = upperBoundStart(segments, to) - 1;
    if (limit < 0 || index.visibleMax[1] < from) return [];
    const result = [];
    collectOverlaps(index, segments, 1, 0, index.size - 1, limit, from, result);
    return result;
  }

  function findRightmostActive(index, node, left, right, limit, timestamp) {
    if (left > limit || index.activeMax[node] <= timestamp) return -1;
    if (left === right) return left;
    const middle = (left + right) >> 1;
    if (middle < limit) {
      const found = findRightmostActive(
        index, node * 2 + 1, middle + 1, right, limit, timestamp,
      );
      if (found >= 0) return found;
    }
    return findRightmostActive(index, node * 2, left, middle, limit, timestamp);
  }

  function latestRecordingAt(segments, timestamp) {
    if (!segments.length) return null;
    const index = intervalIndex(segments);
    if (!index.sorted) {
      let latest = null;
      segments.forEach(segment => {
        if (segment.start_ts <= timestamp &&
            (segment.end_ts == null || timestamp < segment.end_ts) &&
            (!latest || segment.start_ts > latest.start_ts)) latest = segment;
      });
      return latest;
    }
    const limit = upperBoundStart(segments, timestamp) - 1;
    if (limit < 0) return null;
    const found = findRightmostActive(
      index, 1, 0, index.size - 1, limit, timestamp,
    );
    return found >= 0 ? segments[found] : null;
  }

  function lastSegmentStartingBetween(segments, fromExclusive, toInclusive) {
    if (!segments.length || toInclusive < fromExclusive) return null;
    const index = intervalIndex(segments);
    if (!index.sorted) {
      let latest = null;
      segments.forEach(segment => {
        if (segment.start_ts > fromExclusive && segment.start_ts <= toInclusive &&
            (!latest || segment.start_ts > latest.start_ts)) latest = segment;
      });
      return latest;
    }
    const candidate = segments[upperBoundStart(segments, toInclusive) - 1];
    return candidate && candidate.start_ts > fromExclusive ? candidate : null;
  }

  function safeSeekTarget(globalTime, recordingStart, duration) {
    const target = Math.max(0, globalTime - recordingStart);
    if (!Number.isFinite(duration) || duration <= 0) return target;
    return Math.min(target, Math.max(0, duration - 0.05));
  }

  function playbackCompleted({
    ended, currentTime, expectedDuration, metadataReady, hasPlayed,
    buffering = false, warming = false,
  }) {
    if (buffering || warming) return false;
    if (!ended || !metadataReady || !hasPlayed) return false;
    if (!Number.isFinite(expectedDuration) || expectedDuration <= 0) return true;
    return currentTime >= expectedDuration - 0.5;
  }

  function requiredPlaybackBuffer(speed, currentTime, expectedDuration) {
    const desired = speed >= 8 ? 4 : speed >= 4 ? 2 : 0.75;
    if (!Number.isFinite(expectedDuration)) return desired;
    return Math.min(desired, Math.max(0, expectedDuration - currentTime - 0.5));
  }

  function timelinePlaybackSpeed(playbackRate, streamSpeed) {
    const mediaRate = Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1;
    const encodedRate = Number.isFinite(streamSpeed) && streamSpeed > 0 ? streamSpeed : 1;
    return mediaRate * encodedRate;
  }

  function playbackPlan(profile, speed) {
    const selectedSpeed = Number.isFinite(speed) && speed > 0 ? speed : 1;
    const transcoded = profile === 'balanced' || profile === 'fast';
    return {
      transcoded,
      streamSpeed: transcoded ? Math.max(1, selectedSpeed) : 1,
      playbackRate: transcoded ? Math.min(1, selectedSpeed) : selectedSpeed,
    };
  }

  function transcodedTailHasFrame(remainingTimeline, streamSpeed, outputFps) {
    if (!Number.isFinite(remainingTimeline) || remainingTimeline <= 0) return false;
    const speed = Number.isFinite(streamSpeed) && streamSpeed > 0 ? streamSpeed : 1;
    const fps = Number.isFinite(outputFps) && outputFps > 0 ? outputFps : 1;
    return remainingTimeline * fps / speed >= 1;
  }

  function recordingAt(segments, timestamp) {
    let low = 0;
    let high = segments.length - 1;
    let candidate = null;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const segment = segments[middle];
      if (segment.start_ts <= timestamp) {
        candidate = segment;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (!candidate) return null;
    return candidate.end_ts == null || timestamp < candidate.end_ts
      ? candidate
      : null;
  }

  function mediaTimeForTimeline(
    globalTime, recordingStart, streamOffset, streamSpeed, expectedDuration,
  ) {
    const speed = Number.isFinite(streamSpeed) && streamSpeed > 0 ? streamSpeed : 1;
    const target = Math.max(0, (globalTime - recordingStart - streamOffset) / speed);
    if (!Number.isFinite(expectedDuration) || expectedDuration <= 0) return target;
    return Math.min(target, Math.max(0, expectedDuration - 0.05));
  }

  function timelineTimeForMedia(mediaTime, recordingStart, streamOffset, streamSpeed) {
    const speed = Number.isFinite(streamSpeed) && streamSpeed > 0 ? streamSpeed : 1;
    return recordingStart + streamOffset + mediaTime * speed;
  }

  function medianTime(times) {
    const values = times.filter(Number.isFinite).sort((a, b) => a - b);
    if (!values.length) return null;
    const middle = Math.floor(values.length / 2);
    return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
  }

  return {
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
  };
});
