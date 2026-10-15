const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { createApp } = require('../server');

const TYPES = ['Named_Boxarts', 'Named_Titles', 'Named_Snaps', 'Named_Logos'];
const SYSTEM = 'Nintendo - Game Boy';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=',
  'base64'
);
const SECRET = 'OUTSIDE_FIXTURE_SECRET';
const validFiles = [
  'Game 2.png', 'Game 10.png', "Game's Name (USA).png", 'Pokémon.PNG',
  '100% Complete #1.png', '%2e%2e%2fGame.png'
];
let temp;
let root;
let outside;
let server;

function write(file, content = PNG) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function link(target, file, directory = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.symlinkSync(target, file, directory ? 'dir' : 'file');
}

// Use a raw HTTP path so the client does not normalize traversal before sending it.
function request(url) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port: server.address().port, path: url }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks)
      }));
    });
    req.on('error', reject);
  });
}

function imageUrl(system, type, file) {
  return '/img/' + [system, type, file].map(encodeURIComponent).join('/');
}

function listingUrl(system, extra = '') {
  return '/api/thumbnails?system=' + encodeURIComponent(system) + extra;
}

function json(response) {
  return JSON.parse(response.body.toString());
}

function denied(response, statuses = [400, 404]) {
  assert.ok(statuses.includes(response.status), `Unexpected status ${response.status}`);
  assert.ok(!response.body.includes(Buffer.from(SECRET)), 'Outside fixture was disclosed');
}

before(async () => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'thumbnail-server-'));
  root = path.join(temp, 'repo');
  outside = path.join(temp, 'repo-sibling');
  fs.mkdirSync(root);
  for (const file of validFiles) write(path.join(root, SYSTEM, TYPES[0], file));
  for (const type of TYPES.slice(1)) write(path.join(root, SYSTEM, type, 'Other.png'));
  write(path.join(root, "Jump 'n Bump", TYPES[0], 'Jump.png'));
  write(path.join(root, '日本語', TYPES[0], 'ゲーム.png'));
  fs.mkdirSync(path.join(root, 'Uninitialized System'));
  write(path.join(outside, TYPES[0], 'secret.png'), SECRET);
  write(path.join(outside, TYPES[0], 'private.txt'), SECRET);
  write(path.join(root, SYSTEM, TYPES[0], 'private.txt'), SECRET);
  write(path.join(root, SYSTEM, TYPES[0], '.hidden.png'), SECRET);
  fs.mkdirSync(path.join(root, SYSTEM, TYPES[0], 'directory.png'));
  for (const suffix of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
    write(path.join(root, SYSTEM, TYPES[0], 'private.png' + suffix), SECRET);
  }

  for (const name of ['.git', 'public', 'node_modules']) {
    write(path.join(root, name, TYPES[0], 'private.png'), SECRET);
  }
  link(outside, path.join(root, 'Outside System'), true);
  link(path.join(root, SYSTEM), path.join(root, 'Inside System'), true);
  link(path.join(temp, 'missing'), path.join(root, 'Broken System'), true);
  link(path.join(outside, TYPES[0]), path.join(root, 'Type Links', TYPES[0]), true);
  link(path.join(root, SYSTEM, TYPES[1]), path.join(root, 'Type Links', TYPES[1]), true);
  link(path.join(temp, 'missing'), path.join(root, 'Type Links', TYPES[2]), true);
  link(path.join(outside, TYPES[0], 'secret.png'), path.join(root, SYSTEM, TYPES[0], 'outside.png'));
  link(path.join(root, SYSTEM, TYPES[0], validFiles[0]), path.join(root, SYSTEM, TYPES[0], 'inside.png'));
  link(path.join(root, SYSTEM, TYPES[0], 'private.txt'), path.join(root, SYSTEM, TYPES[0], 'text-link.png'));
  link(path.join(temp, 'missing'), path.join(root, SYSTEM, TYPES[0], 'broken.png'));

  const app = createApp(root);
  app.set('env', 'test');
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (temp) fs.rmSync(temp, { recursive: true, force: true });
});

test('systems count only regular thumbnails in allowed directories', async () => {
  const response = await request('/api/systems');
  assert.equal(response.status, 200);
  const systems = json(response).systems;
  assert.deepEqual(new Set(systems.map(system => system.name)), new Set([SYSTEM, "Jump 'n Bump", '日本語']));
  const main = systems.find(system => system.name === SYSTEM);
  assert.deepEqual(main.types, { Named_Boxarts: 6, Named_Titles: 1, Named_Snaps: 1, Named_Logos: 1 });
  assert.equal(main.total, 9);
});

test('listing preserves PNG names, numeric sorting and pagination', async () => {
  const expected = [...validFiles].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  const response = await request(listingUrl(SYSTEM));
  assert.equal(response.status, 200);
  assert.deepEqual(json(response), { thumbnails: expected, total: 6, page: 1, perPage: 60 });
  const page = await request(listingUrl(SYSTEM, '&page=2&perPage=2'));
  assert.deepEqual(json(page), { thumbnails: expected.slice(2, 4), total: 6, page: 2, perPage: 2 });
});

for (const file of validFiles) {
  test(`valid image remains accessible: ${file}`, async () => {
    const response = await request(imageUrl(SYSTEM, TYPES[0], file));
    assert.equal(response.status, 200);
    assert.match(response.headers['content-type'], /^image\/png/);
    assert.deepEqual(response.body, PNG);
  });
}

for (const [system, file] of [["Jump 'n Bump", 'Jump.png'], ['日本語', 'ゲーム.png']]) {
  test(`valid system name remains accessible: ${system}`, async () => {
    assert.deepEqual(json(await request(listingUrl(system))).thumbnails, [file]);
    assert.deepEqual((await request(imageUrl(system, TYPES[0], file))).body, PNG);
  });
}

for (const type of TYPES) {
  test(`allowed thumbnail type: ${type}`, async () => {
    const file = type === TYPES[0] ? validFiles[0] : 'Other.png';
    const listing = await request(listingUrl(SYSTEM, '&type=' + type));
    assert.equal(listing.status, 200);
    assert.ok(json(listing).thumbnails.includes(file));
    assert.deepEqual((await request(imageUrl(SYSTEM, type, file))).body, PNG);
  });
}

for (const system of ['..', '.', '../repo-sibling', '..\\repo-sibling', '/tmp', 'C:\\tmp',
  'Nintendo - Game Boy/..', 'Nintendo - Game Boy\\..', 'bad\0name',
  '.git', 'public', 'node_modules', 'Unknown System', 'Outside System', 'Inside System', 'Broken System']) {
  test(`reject unsafe or non-allowed system: ${JSON.stringify(system)}`, async () => {
    denied(await request(listingUrl(system)), [400]);
    denied(await request(imageUrl(system, TYPES[0], 'secret.png')), [400]);
    denied(await request(imageUrl(system, TYPES[0], 'private.txt')), [400]);
  });
}

test('absolute outside path is rejected by both endpoints', async () => {
  denied(await request(listingUrl(outside)), [400]);
  denied(await request(imageUrl(outside, TYPES[0], 'secret.png')), [400]);
});

for (const query of ['', 'system=', 'system[]=Nintendo+-+Game+Boy',
  'system[name]=Nintendo+-+Game+Boy', 'system=Nintendo+-+Game+Boy&system=..',
  'system=%252e%252e%252frepo-sibling', 'system=%2E%2E%2Frepo-sibling']) {
  test(`reject malformed/encoded listing query: ${query}`, async () => {
    denied(await request('/api/thumbnails?' + query), [400]);
  });
}

for (const type of ['../Named_Boxarts', '..\\Named_Boxarts', 'Unknown_Type']) {
  test(`reject invalid type: ${type}`, async () => {
    denied(await request(listingUrl(SYSTEM, '&type=' + encodeURIComponent(type))), [400]);
    denied(await request(imageUrl(SYSTEM, type, validFiles[0])), [400]);
  });
}

test('reject non-scalar type', async () => {
  denied(await request(listingUrl(SYSTEM, '&type[]=Named_Boxarts')), [400]);
});

for (const file of ['../secret.png', '..\\secret.png', '/secret.png', 'C:\\secret.png',
  'bad\0.png', 'private.txt', 'Game.png.txt', '.hidden.png', 'private.png\n', 'private.png\r',
  'private.png\r\n', 'private.png\u2028', 'private.png\u2029']) {
  test(`reject invalid thumbnail filename: ${JSON.stringify(file)}`, async () => {
    denied(await request(imageUrl(SYSTEM, TYPES[0], file)), [400]);
  });
}

for (const file of ['outside.png', 'inside.png', 'text-link.png', 'broken.png', 'directory.png', 'missing.png']) {
  test(`do not serve symlink, directory or missing image: ${file}`, async () => {
    denied(await request(imageUrl(SYSTEM, TYPES[0], file)), [404]);
  });
}

for (const type of TYPES.slice(0, 3)) {
  test(`do not traverse type symlink: ${type}`, async () => {
    const listing = await request(listingUrl('Type Links', '&type=' + type));
    assert.equal(listing.status, 200);
    assert.deepEqual(json(listing).thumbnails, []);
    denied(await request(imageUrl('Type Links', type, 'secret.png')), [404]);
    denied(await request(imageUrl('Type Links', type, 'Other.png')), [404]);
  });
}

test('uninitialized system and missing type stay empty', async () => {
  assert.deepEqual(json(await request(listingUrl('Uninitialized System'))).thumbnails, []);
  assert.deepEqual(json(await request(listingUrl("Jump 'n Bump", '&type=Named_Logos'))).thumbnails, []);
  denied(await request(imageUrl('Uninitialized System', TYPES[0], 'missing.png')), [404]);
});

test('raw encoded traversal and malformed escape sequences return 4xx', async () => {
  for (const url of [
    '/img/..%2Frepo-sibling/Named_Boxarts/private.txt',
    '/img/%2e%2e%2frepo-sibling/Named_Boxarts/secret.png',
    '/img/..%5Crepo-sibling/Named_Boxarts/secret.png',
    '/img/%252e%252e%252frepo-sibling/Named_Boxarts/secret.png',
    '/img/%E0%A4%A/Named_Boxarts/secret.png',
    '/img/' + encodeURIComponent(SYSTEM) + '/Named_Boxarts/%E0%A4%A.png',
    '/img/' + encodeURIComponent(SYSTEM) + '/Named_Boxarts/%2e%2e%2fsecret.png'
  ]) denied(await request(url));
});

test('trusted repository root can itself use a canonical alias', async () => {
  const alias = path.join(temp, 'repo-alias');
  link(root, alias, true);
  const app = createApp(alias);
  const alternate = app.listen(0, '127.0.0.1');
  await new Promise(resolve => alternate.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${alternate.address().port}` + imageUrl(SYSTEM, TYPES[0], validFiles[0]));
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
  } finally {
    await new Promise(resolve => alternate.close(resolve));
  }
});

test('sync authentication rejects unauthorized clients without invoking the manager', async t => {
  const calls = [];
  const syncManager = { getStatus: () => ({ status: 'idle' }), request: system => {
    calls.push(system);
    if (system === 'busy') throw Object.assign(new Error('Already running'), { statusCode: 409 });
    return { status: 'running', system };
  } };
  const app = createApp(root, { syncManager, syncToken: 'operator-test-token' });
  const secured = app.listen(0, '127.0.0.1');
  await new Promise(resolve => secured.once('listening', resolve));
  t.after(() => new Promise(resolve => secured.close(resolve)));
  const base = `http://127.0.0.1:${secured.address().port}`;
  const post = (headers = {}, body = JSON.stringify({ system: SYSTEM })) => fetch(base + '/api/sync', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body
  });
  for (const headers of [{}, { Authorization: 'Bearer wrong' }, { Authorization: 'Basic operator-test-token' },
    { Authorization: 'Bearer' }, { Authorization: 'Bearer operator-test-token-extra' },
    { Cookie: 'SYNC_TOKEN=operator-test-token' }, { 'X-Forwarded-For': '127.0.0.1' }]) {
    const result = await post(headers);
    assert.equal(result.status, 401);
    assert.equal(result.headers.get('www-authenticate'), 'Bearer');
    assert.ok(!(await result.text()).includes('operator-test-token'));
  }
  assert.equal((await fetch(base + '/api/sync?token=operator-test-token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
  })).status, 401);
  const auth = { Authorization: 'Bearer operator-test-token' };
  // Auth must run before both content-type validation and the body parser.
  for (const headers of [{}, { Authorization: 'Bearer wrong' }]) {
    for (const [type, body] of [
      ['text/plain', '{}'], ['application/x-www-form-urlencoded', 'system=x'],
      ['application/json', '{'], ['application/json', JSON.stringify({ system: 'x'.repeat(3000) })]
    ]) {
      assert.equal((await post({ ...headers, 'Content-Type': type }, body)).status, 401);
    }
  }
  assert.equal((await post({ ...auth, 'Content-Type': 'text/plain' }, '{}')).status, 415);
  assert.equal((await post(auth, '{')).status, 400);
  assert.equal((await post(auth, JSON.stringify({ system: 'x'.repeat(3000) }))).status, 413);
  assert.deepEqual(calls, []);
  for (const url of ['/api/systems', listingUrl(SYSTEM), imageUrl(SYSTEM, TYPES[0], validFiles[0]), '/api/sync-status', '/']) {
    assert.equal((await fetch(base + url)).status, 200);
  }
  assert.equal((await post(auth)).status, 202);
  assert.equal((await post(auth, '{}')).status, 202);
  assert.equal((await post(auth, '{"system":"busy"}')).status, 409);
  assert.deepEqual(calls, [SYSTEM, undefined, 'busy']);
});

test('missing or empty operator token disables manual sync but preserves browsing', async t => {
  for (const syncToken of ['', undefined]) {
    let called = false;
    // An explicit empty token overrides any environment credential.
    const app = createApp(root, { syncToken: syncToken ?? '', syncManager: {
      getStatus: () => ({ status: 'idle' }), request: () => { called = true; }
    } });
    const instance = app.listen(0, '127.0.0.1');
    await new Promise(resolve => instance.once('listening', resolve));
    t.after(() => new Promise(resolve => instance.close(resolve)));
    const base = `http://127.0.0.1:${instance.address().port}`;
    assert.equal((await fetch(base + '/api/sync', { method: 'POST', headers: {
      'Content-Type': 'application/json', Authorization: 'Bearer anything'
    }, body: '{}' })).status, 503);
    for (const headers of [{}, { Authorization: 'Bearer anything' }]) {
      const result = await fetch(base + '/api/sync-auth', { headers });
      assert.equal(result.status, 503);
      assert.equal(result.headers.get('cache-control'), 'no-store');
    }
    assert.equal((await fetch(base + '/api/sync', { method: 'POST', headers: {
      'Content-Type': 'application/json'
    }, body: '{' })).status, 503);
    assert.equal((await fetch(base + '/api/systems')).status, 200);
    assert.equal(called, false);
  }
});

test('credential verification distinguishes tokens without changing sync state or artwork', async t => {
  const calls = [];
  const status = { status: 'idle', revision: 7, lastSync: null };
  const artwork = path.join(root, SYSTEM, TYPES[0], validFiles[0]);
  const before = fs.readFileSync(artwork);
  const app = createApp(root, { syncToken: 'operator-test-token', syncManager: {
    getStatus: () => ({ ...status }), request: system => { calls.push(system); status.revision++; }
  } });
  app.set('env', 'test');
  const instance = app.listen(0, '127.0.0.1');
  await new Promise(resolve => instance.once('listening', resolve));
  t.after(() => new Promise(resolve => instance.close(resolve)));
  const base = `http://127.0.0.1:${instance.address().port}`;
  const auth = { Authorization: 'Bearer operator-test-token' };
  const verify = (headers = {}, query = '') => fetch(base + '/api/sync-auth' + query, { headers });
  const initialStatus = await (await fetch(base + '/api/sync-status')).json();

  for (const query of ['', '?system=' + encodeURIComponent(SYSTEM), '?system=..&download=true']) {
    const result = await verify(auth, query);
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { authenticated: true });
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.match(result.headers.get('vary'), /\bAuthorization\b/);
  }
  const etag = (await verify(auth)).headers.get('etag');
  for (const headers of [{}, { Authorization: 'Bearer wrong' }, { Authorization: 'Basic operator-test-token' },
    { Authorization: 'Bearer' }, { Authorization: 'Bearer operator-test-token-extra' },
    { Cookie: 'SYNC_TOKEN=operator-test-token' }, { 'X-Forwarded-For': '127.0.0.1' },
    { 'If-None-Match': etag }]) {
    const result = await verify(headers, '?token=operator-test-token');
    assert.equal(result.status, 401);
    assert.equal(result.headers.get('www-authenticate'), 'Bearer');
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.match(result.headers.get('vary'), /\bAuthorization\b/);
    assert.ok(!(await result.text()).includes('operator-test-token'));
  }
  // Use raw HTTP: fetch intentionally forbids GET bodies. Neither a system in
  // a body nor malformed/oversized JSON may reach the sync manager.
  for (const headers of [{}, { Authorization: 'Bearer wrong' }, auth]) {
    for (const [body, authorizedStatus] of [
      [JSON.stringify({ system: SYSTEM }), 200], ['{', 400],
      [JSON.stringify({ system: 'x'.repeat(3000) }), 413]
    ]) {
      const response = await new Promise((resolve, reject) => {
        const req = http.request(base + '/api/sync-auth', { method: 'GET', headers: {
          'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers
        } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
        req.on('error', reject);
        req.end(body);
      });
      assert.equal(response, headers === auth ? authorizedStatus : 401);
    }
  }
  assert.equal((await fetch(base + '/api/sync-auth', {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ system: SYSTEM })
  })).status, 404);
  assert.deepEqual(calls, []);
  assert.deepEqual(await (await fetch(base + '/api/sync-status')).json(), initialStatus);
  assert.deepEqual(fs.readFileSync(artwork), before);
  assert.deepEqual(Buffer.from(await (await fetch(base + imageUrl(SYSTEM, TYPES[0], validFiles[0]))).arrayBuffer()), before);
});

test('verification through a proxy fails when Authorization is stripped', async t => {
  let called = false;
  const app = createApp(root, { syncToken: 'operator-test-token', syncManager: {
    getStatus: () => ({ status: 'idle' }), request: () => { called = true; }
  } });
  const origin = app.listen(0, '127.0.0.1');
  await new Promise(resolve => origin.once('listening', resolve));
  t.after(() => new Promise(resolve => origin.close(resolve)));
  let stripAuthorization = false;
  const proxy = http.createServer((req, res) => {
    const headers = { ...req.headers };
    if (stripAuthorization) delete headers.authorization;
    const upstream = http.request({ hostname: '127.0.0.1', port: origin.address().port,
      path: req.url, method: req.method, headers }, response => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  proxy.listen(0, '127.0.0.1');
  await new Promise(resolve => proxy.once('listening', resolve));
  t.after(() => new Promise(resolve => proxy.close(resolve)));
  const url = `http://127.0.0.1:${proxy.address().port}/api/sync-auth`;
  for (const strip of [false, true]) {
    stripAuthorization = strip;
    for (const [headers, expected] of [[{}, 401], [{ Authorization: 'Bearer wrong' }, 401],
      [{ Authorization: 'Bearer operator-test-token' }, strip ? 401 : 200]]) {
      const result = await fetch(url, { headers });
      assert.equal(result.status, expected);
      assert.equal(result.headers.get('cache-control'), 'no-store');
      if (expected === 200) assert.deepEqual(await result.json(), { authenticated: true });
      else await result.text();
    }
  }
  assert.equal(called, false);
});
