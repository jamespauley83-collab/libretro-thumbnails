const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const REPO_ROOT = __dirname;
const THUMB_TYPES = ['Named_Boxarts', 'Named_Titles', 'Named_Snaps', 'Named_Logos'];

// Serve frontend
app.use(express.static(path.join(__dirname, 'public')));

// List all systems with thumbnail counts
app.get('/api/systems', (req, res) => {
  const entries = fs.readdirSync(REPO_ROOT, { withFileTypes: true });
  const systems = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'public') continue;
    const sysPath = path.join(REPO_ROOT, entry.name);
    let totalCount = 0;
    const types = {};
    for (const t of THUMB_TYPES) {
      const tPath = path.join(sysPath, t);
      if (fs.existsSync(tPath) && fs.statSync(tPath).isDirectory()) {
        const files = fs.readdirSync(tPath).filter(f => f.toLowerCase().endsWith('.png'));
        types[t] = files.length;
        totalCount += files.length;
      }
    }
    if (totalCount > 0) {
      systems.push({ name: entry.name, types, total: totalCount });
    }
  }
  systems.sort((a, b) => a.name.localeCompare(b.name));
  res.json({ systems });
});

// List thumbnails for a specific system and type (paginated)
app.get('/api/thumbnails', (req, res) => {
  const system = req.query.system;
  const type = req.query.type || 'Named_Boxarts';
  const page = parseInt(req.query.page) || 1;
  const perPage = parseInt(req.query.perPage) || 60;

  if (!system) return res.status(400).json({ error: 'Missing system parameter' });
  if (!THUMB_TYPES.includes(type)) return res.status(400).json({ error: 'Invalid type' });

  const dirPath = path.join(REPO_ROOT, system, type);
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    return res.json({ thumbnails: [], total: 0, page, perPage });
  }

  let files = fs.readdirSync(dirPath).filter(f => f.toLowerCase().endsWith('.png'));
  files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

  const total = files.length;
  const start = (page - 1) * perPage;
  const pageFiles = files.slice(start, start + perPage);

  res.json({ thumbnails: pageFiles, total, page, perPage });
});

// Serve an individual thumbnail image
app.get('/img/:system/:type/:file', (req, res) => {
  const { system, type, file } = req.params;
  if (!THUMB_TYPES.includes(type)) return res.status(400).send('Invalid type');

  const filePath = path.join(REPO_ROOT, system, type, file);
  // Prevent path traversal
  const resolvedPath = path.resolve(filePath);
  const allowedRoot = path.resolve(path.join(REPO_ROOT, system, type));
  if (!resolvedPath.startsWith(allowedRoot + path.sep) && resolvedPath !== allowedRoot) {
    return res.status(403).send('Forbidden');
  }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return res.status(404).send('Not found');
  }
  res.sendFile(filePath);
});

// Sync status endpoint
app.get('/api/sync-status', (req, res) => {
  const statusFile = '/tmp/.sync-status';
  const logFile = '/tmp/.sync-log';
  let status = 'idle';
  let lastSync = null;
  let log = '';
  try {
    const raw = fs.readFileSync(statusFile, 'utf8').trim();
    const parts = raw.split('|');
    lastSync = parts[0] || null;
    status = parts[1] || 'idle';
  } catch {}
  try {
    log = fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-20).join('\n');
  } catch {}
  res.json({ status, lastSync, log });
});

// Manual sync trigger endpoint
app.post('/api/sync', (req, res) => {
  const { exec } = require('child_process');
  exec('git submodule update --remote --depth=1', { cwd: REPO_ROOT }, (err, stdout, stderr) => {
    if (err) {
      return res.status(500).json({ error: 'Sync failed', details: stderr });
    }
    const ts = new Date().toISOString();
    fs.writeFileSync('/tmp/.sync-status', `${ts}|done`);
    res.json({ status: 'done', lastSync: ts, output: stdout });
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Thumbnail browser running at http://0.0.0.0:${PORT}`);
});
