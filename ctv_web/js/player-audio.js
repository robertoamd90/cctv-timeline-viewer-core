/* One explicitly selected camera, audible only during synchronized 1x playback. */
(function(root) {
  const speaker = '<path d="M11 5 6 9H3v6h3l5 4V5Z"/>';
  const waves = '<path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>';
  const slash = '<path d="m3 3 18 18"/>';
  let options, selected = null, day;
  function sync() {
    if (!options) return;
    const state = options.state(), videos = options.videos();
    if (state.speed !== 1 || state.hidden || (day != null && state.day != null && day !== state.day)) selected = null;
    if (state.day != null) day = state.day;
    if (selected != null && !videos.some(v => v.parentElement.dataset.cam === selected)) selected = null;
    // Mute every other camera before enabling the new one, including warmup.
    const audible = videos.find(v => v.parentElement.dataset.cam === selected && state.speed === 1 &&
      state.playing && !state.buffering && !state.hidden && !v.hidden && !v.seeking && !v.error &&
      v.dataset.warming !== '1' && v.dataset.syncHeld !== '1' &&
      v.parentElement.dataset.buffering !== '1' && v.parentElement.dataset.failed !== '1');
    videos.forEach(v => { if (v !== audible && !v.muted) v.muted = true; });
    if (audible?.muted) audible.muted = false;
    videos.forEach(v => {
      const button = v.parentElement.querySelector('.player-audio');
      if (!button) return;
      const active = v.parentElement.dataset.cam === selected, disabled = state.speed !== 1;
      const labelKey = disabled ? 'player.audioAt1x' : active ? 'player.audioOff' : 'player.audioOn';
      const label = options.label(labelKey);
      const key = `${active}:${disabled}:${label}`;
      if (button.dataset.audioState === key) return;
      button.dataset.audioState = key;
      button.disabled = disabled;
      button.setAttribute('aria-pressed', String(active));
      button.setAttribute('data-i18n-aria-label', labelKey);
      button.setAttribute('data-i18n-title', labelKey);
      button.setAttribute('aria-label', label); button.title = label;
      button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${speaker}${active ? waves : slash}</svg>`;
    });
  }
  function reset() { selected = null; sync(); }
  function toggle(camera) {
    if (options.state().speed !== 1) return;
    const key = String(camera); selected = selected === key ? null : key; sync();
  }
  function blocked(video) {
    if (video.parentElement.dataset.cam !== selected) return false;
    reset(); options.blocked?.(); return true;
  }
  root.CtvPlayerAudio = {
    configure(value) { options = value; sync(); }, sync, reset, toggle, blocked,
    markPause(video) {
      if (!video.paused) video._audioIntentionalPauses = (video._audioIntentionalPauses || 0) + 1;
    },
    attach(video) {
      const button = video.parentElement.querySelector('.player-audio');
      button.onclick = event => { event.stopPropagation(); toggle(video.parentElement.dataset.cam); };
      button.ondblclick = event => event.stopPropagation();
      // An automatic unmute can be denied by Safari even after muted playback
      // succeeds. Restore silent playback instead of freezing the global clock.
      video.addEventListener('pause', () => {
        if (video._audioIntentionalPauses) { video._audioIntentionalPauses--; return; }
        if (video.paused && !video.error && !video.muted && !video.ended && options.state().playing && blocked(video)) options.resume(video);
      });
    },
  };
})(globalThis);
