/* Five draft fields; only Save camera persists their serialized associations. */
(() => {
  const kinds = ['person', 'vehicle', 'animal', 'motion', 'doorbell'];
  const hidden = document.getElementById('cam-ha-events');
  const root = document.getElementById('ha-event-fields');
  const status = document.getElementById('ha-entities-status');
  const retry = document.getElementById('ha-entities-retry');
  let entities = [], loaded = false, loading = null;
  const fields = new Map();
  function serialize() {
    hidden.value = kinds.flatMap(kind => fields.get(kind).selected.map(id => `${id}=${kind}`)).join('\n');
  }
  function close(field) {
    field.menu.hidden = true;
    field.input.setAttribute('aria-expanded', 'false');
    field.input.removeAttribute('aria-activedescendant');
    field.active = -1;
  }
  function showSelected(field) {
    const matches = field.selected.map(id => entities.find(entity => entity.entity_id === id));
    field.input.readOnly = field.selected.length > 0;
    field.input.value = field.selected.map((id, i) => matches[i]?.name || id).join(', ');
    field.clear.hidden = field.selected.length === 0;
    field.row.classList.toggle('has-selection', field.selected.length > 0);
    field.detail.textContent = field.selected.join(' · ');
    if (field.selected.length > 1) field.detail.textContent += ' — ' + t('events.legacyMultiple');
    else if (loaded && field.selected.length && !matches[0]) field.detail.textContent += ' — ' + t('events.missing');
    close(field);
  }
  function choose(field, entity) {
    field.selected = [entity.entity_id]; serialize(); showSelected(field); field.input.focus();
  }
  function suggestions(field) {
    if (field.selected.length) return;
    for (const other of fields.values()) if (other !== field) close(other);
    const query = field.input.value.trim().toLocaleLowerCase();
    const used = new Set([...fields.values()].flatMap(item => item.selected));
    field.matches = entities.filter(item => !used.has(item.entity_id) && `${item.name} ${item.entity_id}`.toLocaleLowerCase().includes(query)).slice(0, 50);
    field.menu.replaceChildren(); field.active = -1;
    field.input.removeAttribute('aria-activedescendant');
    if (!loaded) { close(field); return; }
    field.matches.forEach((item, index) => {
      const option = document.createElement('div');
      option.id = `${field.input.id}-option-${index}`;
      option.setAttribute('role', 'option'); option.setAttribute('aria-selected', 'false');
      const name = document.createElement('strong'); name.textContent = item.name;
      const id = document.createElement('small'); id.textContent = `${item.entity_id} · ${item.state}`;
      option.append(name, id);
      option.onpointerdown = event => event.preventDefault();
      option.onclick = () => choose(field, item);
      field.menu.append(option);
    });
    if (!field.matches.length) {
      const empty = document.createElement('div'); empty.className = 'event-no-results'; empty.textContent = t('events.noMatches'); field.menu.append(empty);
    }
    field.menu.hidden = false; field.input.setAttribute('aria-expanded', 'true');
  }
  async function load() {
    if (loading) return loading;
    retry.hidden = true; status.textContent = t('events.loading');
    loading = (async () => {
      try {
        entities = (await api('/api/admin/ha-event-entities')).entities; loaded = true;
        status.textContent = entities.length ? '' : t('events.empty');
        for (const field of fields.values()) {
          if (field.selected.length) showSelected(field);
          else if (document.activeElement === field.input) suggestions(field);
        }
      } catch (error) {
        const code = String(error.message || '');
        const known = ['missing_token','unauthorized','http_error','dns_error','timeout','permission_denied','connection_error','response_too_large','invalid_response','invalid_request'];
        status.textContent = t('events.discoveryError') + (code.startsWith('ha_entities.') && known.includes(code.slice(12)) ? ' ' + t(code) : '');
        retry.hidden = false;
      } finally { loading = null; }
    })();
    return loading;
  }
  for (const kind of kinds) {
    const row = document.createElement('div'); row.className = 'event-field';
    const label = document.createElement('label'); label.htmlFor = `event-entity-${kind}`;
    label.innerHTML = window.CtvEventIcons.svg(kind);
    label.append(document.createTextNode(t('events.' + kind)));
    const control = document.createElement('div'); control.className = 'event-field-control';
    const input = document.createElement('input'); input.id = label.htmlFor; input.type = 'text'; input.autocomplete = 'off';
    input.placeholder = t('events.searchEntity'); input.setAttribute('role','combobox'); input.setAttribute('aria-autocomplete','list'); input.setAttribute('aria-expanded','false');
    const menu = document.createElement('div'); menu.id = `${input.id}-results`; menu.className = 'event-suggestions'; menu.hidden = true; menu.setAttribute('role','listbox'); menu.setAttribute('aria-label',t('events.'+kind)); input.setAttribute('aria-controls',menu.id);
    const detail = document.createElement('small'); detail.className = 'event-selected-id'; detail.id = `${input.id}-detail`; input.setAttribute('aria-describedby',detail.id);
    const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'event-clear'; clear.textContent = '×'; clear.hidden = true; clear.setAttribute('aria-label',`${t('events.remove')} ${t('events.'+kind)}`);
    const field = {kind, label, row, input, menu, detail, clear, selected:[], matches:[], active:-1}; fields.set(kind, field);
    clear.onclick = () => { field.selected = []; serialize(); showSelected(field); input.focus(); };
    input.onfocus = () => { if (!loaded) load(); suggestions(field); };
    input.oninput = () => suggestions(field);
    input.onblur = () => { close(field); if (!field.selected.length) input.value = ''; };
    input.onkeydown = event => {
      if (event.key === 'Escape') { close(field); return; }
      if (event.key === 'Enter') {
        event.preventDefault();
        if (!menu.hidden && field.active >= 0) choose(field, field.matches[field.active]);
      } else if (['ArrowDown','ArrowUp'].includes(event.key) && !field.selected.length) {
        event.preventDefault(); if (menu.hidden) suggestions(field);
        if (!field.matches.length) return;
        field.active = (field.active + (event.key === 'ArrowDown' ? 1 : -1) + field.matches.length) % field.matches.length;
        [...menu.children].forEach((option,i) => option.setAttribute('aria-selected',String(i === field.active)));
        const option = menu.children[field.active]; input.setAttribute('aria-activedescendant', option.id); option.scrollIntoView({block:'nearest'});
      }
    };
    control.append(input,clear,menu); row.append(label,control,detail); root.append(row);
  }
  retry.onclick = () => load();
  window.CtvEventPicker = {
    refreshLabels() {
      for (const field of fields.values()) {
        field.label.innerHTML = window.CtvEventIcons.svg(field.kind);
        field.label.append(document.createTextNode(t('events.' + field.kind)));
        field.input.placeholder = t('events.searchEntity');
        field.clear.setAttribute('aria-label', `${t('events.remove')} ${t('events.' + field.kind)}`);
        field.menu.setAttribute('aria-label', t('events.' + field.kind));
        if (field.selected.length) showSelected(field);
      }
    },
    setMapping(value) {
    for (const field of fields.values()) field.selected = [];
    for (const line of value.split('\n').filter(line => line.trim())) {
      const [entity, kind] = line.split('=').map(part => part.trim());
      if (fields.has(kind)) fields.get(kind).selected.push(entity);
    }
    serialize(); for (const field of fields.values()) showSelected(field);
    if (!loaded && value) load();
  }};
  window.CtvEventPicker.setMapping(hidden.value);
})();
