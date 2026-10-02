const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const SYSTEM = 'Example System';
function harness() {
  const elements = new Map();
  const element = () => ({ innerHTML: '', textContent: '', value: '', hidden: false, disabled: false,
    classList: { add() {} }, addEventListener() {} });
  const context = vm.createContext({
    document: {
      getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
      querySelectorAll() { return []; },
      createElement() { const el = element(); Object.defineProperty(el, 'innerHTML', { get: () => el.textContent.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }); return el; }
    },
    URLSearchParams, setTimeout() {}, fetch: () => new Promise(() => {})
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8'), context);
  const run = source => vm.runInContext(source, context);
  const state = run('state');
  state.systems = [{ name: SYSTEM, total: 0, types: {}, downloadable: true }];
  state.selectedSystem = SYSTEM;
  return { context, state, elements, run };
}
const response = data => ({ ok: true, json: async () => data });

test('empty collection shows explicit download and storage warning without starting a request', () => {
  const { run, elements } = harness();
  run('renderSync()');
  assert.equal(elements.get('sync-system').textContent, 'Download this system');
  assert.equal(elements.get('sync-system').hidden, false);
  assert.equal(elements.get('download-warning').hidden, false);
});

test('repeated download clicks issue one request and send only the selected name', async () => {
  const { context, run, state } = harness();
  let finish;
  const calls = [];
  context.fetch = (url, options) => { calls.push({ url, options }); return new Promise(resolve => { finish = resolve; }); };
  const pending = run('startSync()');
  await run('startSync()');
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].options.body), { system: SYSTEM });
  finish(response({ status: 'running', revision: 1, system: SYSTEM }));
  await pending;
  assert.equal(state.sync.status, 'running');
});

test('a failed completion refresh is retried on the next unchanged status poll', async () => {
  const { context, run, state } = harness();
  state.selectedSystem = null;
  let refreshes = 0;
  context.fetch = async url => {
    if (url === '/api/sync-status') return response({ status: 'done', revision: 2, lastSync: 'now' });
    refreshes++;
    return refreshes === 1 ? { ok: false } : response({ systems: [] });
  };
  await run('pollSync()');
  assert.equal(state.refreshedSyncRevision, null);
  await run('pollSync()');
  assert.equal(refreshes, 2);
  assert.notEqual(state.refreshedSyncRevision, null);
});

test('an older in-flight poll cannot replace the newly accepted download state', async () => {
  const { context, run, state } = harness();
  let finishPoll;
  context.fetch = url => url === '/api/sync-status'
    ? new Promise(resolve => { finishPoll = resolve; })
    : Promise.resolve(response({ status: 'running', revision: 3, system: SYSTEM }));
  const poll = run('pollSync()');
  await run('startSync()');
  finishPoll(response({ status: 'done', revision: 2, lastSync: 'earlier' }));
  await poll;
  assert.equal(state.sync.status, 'running');
  assert.equal(state.sync.revision, 3);
});

test('later thumbnail selection wins when responses arrive out of order', async () => {
  const { context, run, state, elements } = harness();
  state.systems[0].total = 1;
  let finishFirst;
  let requests = 0;
  context.fetch = () => ++requests === 1 ? new Promise(resolve => { finishFirst = resolve; })
    : Promise.resolve(response({ thumbnails: ['New.png'], total: 1 }));
  const first = run('fetchThumbnails()');
  await run('fetchThumbnails()');
  finishFirst(response({ thumbnails: ['Old.png'], total: 1 }));
  await first;
  assert.match(elements.get('thumbnail-grid').innerHTML, /New\.png/);
  assert.doesNotMatch(elements.get('thumbnail-grid').innerHTML, /Old\.png/);
});
