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
