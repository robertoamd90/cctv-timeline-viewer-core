/* Explicit HA entity mapping: never infer event type from a name. */
(() => {
  const field = document.getElementById('cam-ha-events');
  const search = document.getElementById('ha-entity-search');
  const select = document.getElementById('ha-entity-select');
  const type = document.getElementById('ha-event-type');
  const add = document.getElementById('ha-entity-add');
  const load = document.getElementById('ha-entities-load');
  const status = document.getElementById('ha-entities-status');
  const list = document.getElementById('ha-entity-mappings');
  let entities = [], mapping = new Map(), loaded = false;
  function updateAdd() { add.disabled = !select.value || !type.value || mapping.size >= 16; }
  function filter() {
    const selected = select.value;
    const query = search.value.trim().toLocaleLowerCase();
    select.replaceChildren(new Option(t('events.chooseEntity'), ''));
    for (const item of entities) {
      if (mapping.has(item.entity_id) || !`${item.name} ${item.entity_id}`.toLocaleLowerCase().includes(query)) continue;
      select.add(new Option(`${item.name} — ${item.entity_id} (${item.state})`, item.entity_id));
    }
    if ([...select.options].some(option => option.value === selected)) select.value = selected;
    select.disabled = !loaded || select.options.length < 2;
    updateAdd();
  }
  function render() {
    field.value = [...mapping].map(([entity, kind]) => `${entity}=${kind}`).join('\n');
    list.replaceChildren();
    for (const [entity, kind] of mapping) {
      const item = entities.find(item => item.entity_id === entity);
      const row = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = `${item ? item.name + ' — ' : ''}${entity} → ${t('events.' + kind)}${loaded && !item ? ' — ' + t('events.missing') : ''}`;
      const remove = document.createElement('button');
      remove.type = 'button'; remove.textContent = t('events.remove');
      remove.setAttribute('aria-label', `${t('events.remove')} ${entity}`);
      remove.onclick = () => { mapping.delete(entity); render(); };
      row.append(label, remove); list.append(row);
    }
    filter();
  }
  load.onclick = async () => {
    load.disabled = true;
    status.textContent = t('events.loading');
    try {
      const result = await api('/api/admin/ha-event-entities');
      entities = result.entities; loaded = true; search.disabled = false;
      status.textContent = t(entities.length ? 'events.loaded' : 'events.empty');
      render();
    } catch (_) {
      status.textContent = t('events.discoveryError');
    } finally { load.disabled = false; }
  };
  search.oninput = filter;
  select.onchange = updateAdd;
  type.onchange = updateAdd;
  add.onclick = () => {
    if (add.disabled) return;
    mapping.set(select.value, type.value);
    type.value = ''; render();
  };
  window.CtvEventPicker = {
    setMapping(value) {
      mapping = new Map(value.split('\n').filter(line => line.trim()).map(line => line.split('=').map(part => part.trim())));
      search.value = ''; type.value = ''; render();
    }
  };
  window.CtvEventPicker.setMapping(field.value);
})();
