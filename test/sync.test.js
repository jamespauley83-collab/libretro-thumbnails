const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { createApp } = require('../server');
const { createSyncManager, declaredSystems, runGit } = require('../submodule-sync');

const DEFAULT_SYSTEM = 'Nintendo - Nintendo Entertainment System';
const OTHER = "Other [system] ' ; $(touch nope)";
function fixture(t, systems = [DEFAULT_SYSTEM, OTHER]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thumbnail-sync-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [i, name] of systems.entries()) {
    execFileSync('git', ['config', '--file', path.join(root, '.gitmodules'), `submodule.test${i}.path`, name]);
  }
  return root;
}
function done(manager) { return manager.wait().then(() => manager.getStatus()); }

test('fresh checkout lists declared systems even before directories or PNGs exist', async t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'Unknown Empty'));
  const server = createApp(root).listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.once('listening', resolve));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/systems`);
  assert.equal(res.status, 200);
  const systems = (await res.json()).systems;
  assert.deepEqual(new Set(systems.map(s => s.name)), new Set([DEFAULT_SYSTEM, OTHER]));
  assert.ok(systems.every(s => s.total === 0 && s.downloadable));
});

test('startup downloads nothing and manual sync stays bounded', async t => {
  const root = fixture(t);
  const calls = [];
  const manager = createSyncManager(root, { runGit: async (_, systems) => calls.push(systems) });
  manager.start({ intervalSeconds: 0 });
  await done(manager);
  assert.deepEqual(calls, []);
  manager.request(DEFAULT_SYSTEM);
  assert.equal(manager.getStatus().status, 'running');
  assert.equal((await done(manager)).status, 'done');
  assert.deepEqual(calls, [[DEFAULT_SYSTEM]]);
  manager.request();
  await done(manager);
  assert.equal(calls.length, 1);
  fs.mkdirSync(path.join(root, OTHER));
  fs.writeFileSync(path.join(root, OTHER, '.git'), 'gitdir: trusted');
  manager.request();
  await done(manager);
  assert.deepEqual(calls, [[DEFAULT_SYSTEM], [OTHER]]);
});

test('periodic sync never initializes a new collection', async t => {
  const root = fixture(t);
  const calls = [];
  const manager = createSyncManager(root, { runGit: async (_, systems) => calls.push(systems) });
  t.after(() => manager.stop());
  manager.start({ intervalSeconds: 0.01 });
  await new Promise(resolve => setTimeout(resolve, 45));
  manager.stop();
  await done(manager);
  assert.deepEqual(calls, []);
});

test('selected sync is serialized, bounded, failure is visible, and retry succeeds', async t => {
  const root = fixture(t);
  let rejectJob;
  let first = true;
  const manager = createSyncManager(root, { runGit: async (_, systems, log) => {
    assert.deepEqual(systems, [OTHER]);
    log('x'.repeat(10000));
    if (first) {
      first = false;
      await new Promise((_, reject) => { rejectJob = reject; });
    }
  } });
  manager.request(OTHER);
  await Promise.resolve();
  assert.equal(manager.getStatus().status, 'running');
  assert.equal(manager.getStatus().log.length, 8000);
  assert.throws(() => manager.request(OTHER), { statusCode: 409 });
  rejectJob(new Error('Network unavailable'));
  const failed = await done(manager);
  assert.equal(failed.status, 'error');
  assert.equal(failed.error, 'Network unavailable');
  assert.equal(failed.lastSync, null);
  manager.request(OTHER);
  const success = await done(manager);
  assert.equal(success.status, 'done');
  assert.equal(success.error, null);
  assert.ok(success.lastSync);
});

test('unknown, traversal, non-scalar, symlinked systems and .git files are excluded', async t => {
  const bad = ['../outside', '.git', 'public', 'node_modules', 'bad/name', 'bad\\name', 'C:drive'];
  const root = fixture(t, [DEFAULT_SYSTEM, ...bad, 'System Link', 'Git Link']);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'thumbnail-sync-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(root, 'System Link'), 'dir');
  fs.mkdirSync(path.join(root, 'Git Link'));
  fs.symlinkSync(outside, path.join(root, 'Git Link', '.git'), 'dir');
  assert.deepEqual(declaredSystems(root), [DEFAULT_SYSTEM]);
  const manager = createSyncManager(root, { runGit: async () => assert.fail('Git must not run') });
  for (const name of [...bad, 'System Link', 'Git Link', 'Unknown', '', null, [], {}, [DEFAULT_SYSTEM]]) {
    assert.throws(() => manager.request(name), { statusCode: 400 });
  }
  fs.renameSync(path.join(root, '.gitmodules'), path.join(outside, 'modules'));
  fs.symlinkSync(path.join(outside, 'modules'), path.join(root, '.gitmodules'));
  assert.deepEqual(declaredSystems(root), []);
});

test('async sync API returns 202, rejects duplicate/invalid requests and reports completion', async t => {
  const root = fixture(t);
  let finish;
  const sync = createSyncManager(root, { runGit: () => new Promise(resolve => { finish = resolve; }) });
  const server = createApp(root, { syncManager: sync }).listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = system => fetch(base + '/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ system }) });
  assert.equal((await post('../outside')).status, 400);
  assert.equal((await post(DEFAULT_SYSTEM)).status, 202);
  assert.equal((await post(DEFAULT_SYSTEM)).status, 409);
  assert.equal((await (await fetch(base + '/api/sync-status')).json()).status, 'running');
  finish();
  await sync.wait();
  assert.equal((await (await fetch(base + '/api/sync-status')).json()).status, 'done');
});

test('real Git initializes only a literal selected path, with PNGs available through HTTP', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'thumbnail-real-git-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const source = path.join(temp, 'source');
  const original = path.join(temp, 'original');
  const checkout = path.join(temp, 'checkout');
  const git = (cwd, args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  for (const dir of [source, original]) {
    fs.mkdirSync(dir);
    git(dir, ['init', '-b', 'master']);
    git(dir, ['config', 'user.name', 'Fixture']);
    git(dir, ['config', 'user.email', 'fixture@example.invalid']);
  }
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=', 'base64');
  fs.mkdirSync(path.join(source, 'Named_Boxarts'));
  fs.writeFileSync(path.join(source, 'Named_Boxarts', 'Game.png'), png);
  git(source, ['add', '.']);
  git(source, ['commit', '-m', 'fixture']);
  for (const system of ['System [1]', 'System 1']) {
    git(original, ['-c', 'protocol.file.allow=always', 'submodule', 'add', source, system]);
  }
  git(original, ['commit', '-am', 'fixtures']);
  git(temp, ['clone', original, checkout]);
  const manager = createSyncManager(checkout, { runGit: async (root, systems, log) => {
    // File transport is enabled only for these isolated local fixtures.
    const old = process.env.GIT_ALLOW_PROTOCOL;
    process.env.GIT_ALLOW_PROTOCOL = 'file';
    try { await runGit(root, systems, log); }
    finally { if (old === undefined) delete process.env.GIT_ALLOW_PROTOCOL; else process.env.GIT_ALLOW_PROTOCOL = old; }
  } });
  manager.request('System [1]');
  const result = await done(manager);
  assert.equal(result.status, 'done', result.log);
  assert.ok(fs.existsSync(path.join(checkout, 'System [1]', 'Named_Boxarts', 'Game.png')));
  assert.ok(!fs.existsSync(path.join(checkout, 'System 1', '.git')));
  const server = createApp(checkout).listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const systems = (await (await fetch(base + '/api/systems')).json()).systems;
  assert.equal(systems.find(s => s.name === 'System [1]').total, 1);
  const response = await fetch(base + '/img/System%20%5B1%5D/Named_Boxarts/Game.png');
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
});

test('production metadata-only repository downloads, retries and updates only the selected system', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'thumbnail-production-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const source = path.join(temp, 'source');
  const root = path.join(temp, 'app');
  const selected = "Selected [1], '; $(touch nope)";
  const other = 'Selected 1';
  const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  for (const dir of [source, root]) {
    fs.mkdirSync(dir);
    git(dir, ['init', '-b', 'main']);
    git(dir, ['config', 'user.name', 'Fixture']);
    git(dir, ['config', 'user.email', 'fixture@example.invalid']);
  }
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=', 'base64');
  fs.writeFileSync(path.join(source, 'README'), 'Default branch');
  git(source, ['add', '.']);
  git(source, ['commit', '-m', 'default']);
  git(source, ['checkout', '-b', 'thumbnails']);
  fs.mkdirSync(path.join(source, 'Named_Boxarts'));
  fs.writeFileSync(path.join(source, 'Named_Boxarts', 'Game.png'), png);
  git(source, ['add', '.']);
  git(source, ['commit', '-m', 'thumbnails']);
  git(source, ['checkout', 'main']);
  for (const [name, system] of [['different.section', selected], ['untouched', other]]) {
    for (const [key, value] of Object.entries({ path: system, url: pathToFileURL(source).href, branch: 'thumbnails', shallow: 'true' })) {
      git(root, ['config', '--file', '.gitmodules', `submodule.${name}.${key}`, value]);
    }
  }
  // This is the production Dockerfile's starting state: only .gitmodules is
  // committed, with no original index, gitlinks, module history or image data.
  git(root, ['add', '.gitmodules']);
  git(root, ['commit', '-m', 'production metadata']);
  const originalModules = fs.readFileSync(path.join(root, '.gitmodules'));
  assert.equal(git(root, ['ls-files', '--stage']).includes('160000'), false);
  const oldProtocol = process.env.GIT_ALLOW_PROTOCOL;
  process.env.GIT_ALLOW_PROTOCOL = 'file';
  t.after(() => {
    if (oldProtocol === undefined) delete process.env.GIT_ALLOW_PROTOCOL;
    else process.env.GIT_ALLOW_PROTOCOL = oldProtocol;
  });
  const manager = createSyncManager(root);
  t.after(() => manager.stop());
  manager.start({ intervalSeconds: 0 });
  assert.equal((await done(manager)).status, 'done');
  manager.request();
  await done(manager);
  assert.equal(fs.existsSync(path.join(root, selected)), false);
  assert.equal(fs.existsSync(path.join(root, other)), false);

  const server = createApp(root, { syncManager: manager }).listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = () => fetch(base + '/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ system: selected }) });
  const initial = (await (await fetch(base + '/api/systems')).json()).systems;
  assert.equal(initial.length, 2);
  assert.ok(initial.every(system => system.downloadable && system.total === 0));

  // A failed metadata lookup must be visible and leave retry available.
  fs.renameSync(source, source + '-offline');
  const lastSuccess = manager.getStatus().lastSync;
  assert.equal((await post()).status, 202);
  assert.equal((await done(manager)).status, 'error');
  assert.equal(manager.getStatus().lastSync, lastSuccess);
  assert.equal(git(root, ['ls-files', '--stage']).includes('160000'), false);
  fs.renameSync(source + '-offline', source);
  assert.equal((await post()).status, 202);
  const result = await done(manager);
  assert.equal(result.status, 'done', result.log);
  assert.equal(git(path.join(root, selected), ['rev-parse', '--is-shallow-repository']), 'true');
  assert.equal(fs.existsSync(path.join(root, other)), false);
  assert.deepEqual(fs.readFileSync(path.join(root, '.gitmodules')), originalModules);
  const index = git(root, ['ls-files', '--stage', '-z']).split('\0').filter(line => line.startsWith('160000 '));
  assert.equal(index.length, 1);
  assert.ok(index[0].endsWith('\t' + selected));
  const response = await fetch(`${base}/img/${encodeURIComponent(selected)}/Named_Boxarts/Game.png`);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);

  git(source, ['checkout', 'thumbnails']);
  fs.writeFileSync(path.join(source, 'Named_Boxarts', 'New.png'), png);
  git(source, ['add', '.']);
  git(source, ['commit', '-m', 'new thumbnail']);
  git(source, ['checkout', 'main']);
  // Restart and subsequent untargeted updates must reuse the new gitlink,
  // follow the declared non-default branch and leave the other system absent.
  const restarted = createSyncManager(root);
  t.after(() => restarted.stop());
  restarted.start({ intervalSeconds: 0 });
  const updated = await done(restarted);
  assert.equal(updated.status, 'done', updated.log);
  const systems = (await (await fetch(base + '/api/systems')).json()).systems;
  assert.equal(systems.find(system => system.name === selected).total, 2);
  assert.equal(systems.find(system => system.name === other).total, 0);
  assert.equal(fs.existsSync(path.join(root, other)), false);
  assert.equal(fs.existsSync(path.join(root, 'nope')), false);
  assert.deepEqual(fs.readFileSync(path.join(root, '.gitmodules')), originalModules);

  // Missing branches fail before adding a gitlink; removing the optional
  // branch setting retries against the remote's default HEAD.
  for (const [key, value] of Object.entries({ path: 'Default Branch', url: pathToFileURL(source).href, branch: 'not-in-source' })) {
    git(root, ['config', '--file', '.gitmodules', `submodule.default.${key}`, value]);
  }
  manager.request('Default Branch');
  assert.equal((await done(manager)).status, 'error');
  assert.equal(git(root, ['ls-files', '--', 'Default Branch']), '');
  git(root, ['config', '--file', '.gitmodules', '--unset', 'submodule.default.branch']);
  manager.request('Default Branch');
  const defaultResult = await done(manager);
  assert.equal(defaultResult.status, 'done', defaultResult.log);
  assert.equal(git(path.join(root, 'Default Branch'), ['rev-parse', 'HEAD']), git(source, ['rev-parse', 'main']));
  assert.equal(fs.existsSync(path.join(root, other)), false);
});

test('metadata bootstrap does not overwrite an existing tracked file', async t => {
  const root = fixture(t, ['Selected']);
  execFileSync('git', ['init'], { cwd: root, stdio: 'pipe' });
  fs.writeFileSync(path.join(root, 'Selected'), 'Keep this tracked file');
  execFileSync('git', ['add', '.'], { cwd: root, stdio: 'pipe' });
  fs.unlinkSync(path.join(root, 'Selected'));
  const before = execFileSync('git', ['ls-files', '--stage', '-z'], { cwd: root });
  const manager = createSyncManager(root);
  manager.request('Selected');
  const result = await done(manager);
  assert.equal(result.status, 'error');
  assert.match(result.error, /Refusing to replace tracked files/);
  assert.deepEqual(execFileSync('git', ['ls-files', '--stage', '-z'], { cwd: root }), before);
  assert.equal(fs.existsSync(path.join(root, 'Selected')), false);
});

test('timeout and cancellation stop Git and fail instead of reporting success', async t => {
  const root = fixture(t);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = bin + path.delimiter + oldPath;
  try {
    await assert.rejects(runGit(root, [DEFAULT_SYSTEM], () => {}, 25), /timed out/);
    const controller = new AbortController();
    const result = runGit(root, [DEFAULT_SYSTEM], () => {}, 30000, controller.signal);
    controller.abort();
    await assert.rejects(result, /cancelled/);
    fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\ncase "$2" in\nls-files) sleep 0.1; printf "160000 1111111111111111111111111111111111111111 0\\tSelected\\0" ;;\nsubmodule) echo updating >&2; sleep 0.1 ;;\nesac\n', { mode: 0o755 });
    let log = '';
    await assert.rejects(runGit(root, ['Selected'], text => { log += text; }, 150), /timed out/);
    assert.match(log, /updating/); // Both commands fit separately, not together.
  } finally { process.env.PATH = oldPath; }
});
