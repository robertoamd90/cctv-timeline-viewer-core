const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync('ctv_web/js/app.js', 'utf8');

function definition(name) {
  const start = source.indexOf(`function ${name}(`);
  assert(start >= 0, `${name} exists`);
  const end = source.indexOf('\n}', start) + 2;
  const asyncStart = source.slice(start - 6, start) === 'async ' ? start - 6 : start;
  return source.slice(asyncStart, end);
}

async function run() {
  const requests = [];
  const context = vm.createContext({
    appUrl: path => `https://viewer.example${path}`,
    fetch: async (url, options) => {
      requests.push({url, options});
      return {ok: true, json: async () => ({ok: true})};
    },
  });
  vm.runInContext(definition('api'), context);
  await context.api('/api/cameras', {method: 'POST', body: {name: 'Camera'}, headers: {'X-Other': 'retained'}});
  assert.strictEqual(requests[0].options.headers['X-CTV-Request'], '1');
  assert.strictEqual(requests[0].options.headers['X-Other'], 'retained');
  assert.strictEqual(requests[0].options.headers['Content-Type'], 'application/json');
  assert.strictEqual(requests[0].options.body, '{"name":"Camera"}');
  await context.api('/api/admin/rebuild-index', {method: 'POST'});
  assert.strictEqual(requests[1].options.headers['X-CTV-Request'], '1');
  await context.api('/api/cameras/1', {method: 'DELETE'});
  assert.strictEqual(requests[2].options.headers['X-CTV-Request'], '1');
  await context.api('/api/cameras');
  assert.strictEqual(requests[3].options.headers, undefined);

  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {
      hidden: false,
      setAttribute(name) { if (name === 'hidden') this.hidden = true; },
      options: [{value: 'native'}, {value: 'balanced'}, {value: 'fast'}],
    });
    return nodes.get(id);
  };
  const state = {session: {}, streamProfile: 'fast'};
  const session = {deployment: 'php', is_admin: false, source_roots: [], capabilities: {
    transcoding: false, home_assistant_events: false, server_autoscan: false, realtime_events: false,
  }};
  const sessionContext = vm.createContext({
    S: state,
    api: async () => session,
    document: {getElementById: node, querySelector: node},
    localStorage: {setItem() {}},
    switchTab() {},
  });
  vm.runInContext(definition('loadSession'), sessionContext);
  await sessionContext.loadSession();
  assert.strictEqual(state.streamProfile, 'native');
  assert.strictEqual(node('quality-select').value, 'native');
  assert(node('quality-select').options.filter(option => option.value !== 'native').every(option => option.hidden));
  for (const id of ['stream-profile-settings', 'autoscan-settings', 'event-filter-wrap', '.ha-event-picker', '.tab[data-tab="cameras"]']) {
    assert(node(id).hidden, `${id} hidden for PHP/read-only user`);
  }

  let streams = 0, polls = 0, stops = 0;
  const liveState = {session};
  const liveContext = vm.createContext({
    S: liveState,
    liveUpdatesEnabled: true,
    liveGeneration: 1,
    liveEventTypes: ['recording_events', 'scan', 'partition', 'partition_progress'],
    document: {hidden: false},
    stopLiveUpdates() { stops++; },
    pollLiveUpdates() { polls++; },
    appUrl: path => path,
    EventSource: class { constructor() { streams++; } addEventListener() {} },
  });
  vm.runInContext(definition('startLiveUpdates'), liveContext);
  liveContext.startLiveUpdates();
  liveContext.startLiveUpdates();
  assert.strictEqual(streams, 0, 'PHP must never open an SSE connection');
  assert.strictEqual(polls, 0, 'PHP must never start HA polling');
  assert.strictEqual(stops, 2, 'Visibility restart still cancels stale streams');
  liveState.session = {deployment: 'standalone'};
  liveContext.startLiveUpdates();
  assert.strictEqual(streams, 1, 'Python standalone keeps upstream SSE behavior');
  liveState.session = {deployment: 'homeassistant'};
  liveContext.startLiveUpdates();
  assert.strictEqual(polls, 1, 'HA keeps upstream finite polling behavior');
  console.log('PHP frontend behavior tests passed');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
