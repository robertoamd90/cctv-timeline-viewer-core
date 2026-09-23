const selectedEventTypes = new Set();
const eventFilterButton = document.getElementById('btn-event-filter');
const eventFilterMenu = document.getElementById('event-filter-menu');
function renderEventFilter() {
  eventFilterButton.textContent = t('events.filter') + (selectedEventTypes.size ? ` (${selectedEventTypes.size})` : '');
  eventFilterMenu.replaceChildren();
  for (const kind of CtvEventPlayback.kinds) {
    const label = document.createElement('label'); label.className = 'camera-filter-option';
    const input = document.createElement('input'); input.type = 'checkbox'; input.value = kind; input.checked = selectedEventTypes.has(kind);
    const symbol = document.createElement('span'); symbol.innerHTML = CtvEventIcons.svg(kind);
    label.append(input,symbol,document.createTextNode(t('events.'+kind))); eventFilterMenu.append(label);
    input.onchange = () => {
      if(input.checked) selectedEventTypes.add(kind); else selectedEventTypes.delete(kind);
      applyEventFilter();
    };
  }
  const clear = document.createElement('button'); clear.type='button'; clear.textContent=t('events.showAll');
  clear.onclick=()=>{selectedEventTypes.clear();applyEventFilter();};eventFilterMenu.append(clear);
}
function applyEventFilter() {
  const resume = S.playing;
  stopPlayback();
  if (S.unfilteredTimeline) {
    S.timeline = CtvEventPlayback.filterTimeline(S.unfilteredTimeline,selectedEventTypes);
    const ids = displayedCameras().map(camera=>camera.id);
    const next = CtvEventPlayback.playableTime(S.timeline,ids,S.currentTime ?? -Infinity)
      ?? CtvEventPlayback.playableTime(S.timeline,ids,-Infinity);
    if (next != null) seekTo(next);
    else toast(t('events.noMatchingClips'),'info');
    renderTimeline(); renderPlayers(); updateCursor(); updateTimeDisplay();
    if (resume && next != null) document.getElementById('btn-play').click();
  }
  renderEventFilter();
}
eventFilterButton.onclick=()=>{
  eventFilterMenu.hidden=!eventFilterMenu.hidden;
  eventFilterButton.setAttribute('aria-expanded',String(!eventFilterMenu.hidden));
};
document.addEventListener('click',event=>{
  if(!event.target.closest('#event-filter-wrap')) {eventFilterMenu.hidden=true;eventFilterButton.setAttribute('aria-expanded','false');}
});
eventFilterMenu.addEventListener('keydown',event=>{
  if(event.key==='Escape'){eventFilterMenu.hidden=true;eventFilterButton.setAttribute('aria-expanded','false');eventFilterButton.focus();}
});
renderEventFilter();
