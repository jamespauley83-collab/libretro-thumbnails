const express = require('express');
const path = require('path');
const fs = require('fs');
const { createSyncManager, declaredSystems } = require('./submodule-sync');

const THUMB_TYPES = ['Named_Boxarts', 'Named_Titles', 'Named_Snaps', 'Named_Logos'];

// Express has already decoded route and query parameters. Treat each as one
// component, not a path; do not decode it a second time.
function isComponent(value) {
  return typeof value === 'string' && value.length > 0 &&
    value !== '.' && value !== '..' && !/[\\/\0:]/.test(value);
}

function isSystemName(value) {
  return isComponent(value) && !value.startsWith('.') &&
    value !== 'node_modules' && value !== 'public';
}

function isPng(value) {
  return isComponent(value) && !value.startsWith('.') && value.toLowerCase().endsWith('.png');
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' &&
    !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

// All roots come from the trusted repository, never unchecked request input.
// Reject symlinks at every level, then verify the real path is still contained.
function resolveChild(root, name, directory) {
  if (!isComponent(name)) return null;
  try {
    const candidate = path.join(root, name);
    const stat = fs.lstatSync(candidate);
    if (directory ? !stat.isDirectory() : !stat.isFile()) return null;
    const realPath = fs.realpathSync(candidate);
    return isWithin(root, realPath) ? realPath : null;
  } catch (err) {
    if (['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES'].includes(err.code)) return null;
    throw err;
  }
}

function listPngs(dirPath) {
  return fs.readdirSync(dirPath, { withFileTypes: true })
    .filter(entry => entry.isFile() && isPng(entry.name))
    .map(entry => entry.name);
}

function createApp(repoRoot = __dirname, options = {}) {
  const app = express();
  const REPO_ROOT = fs.realpathSync(repoRoot);
  const sync = options.syncManager || createSyncManager(REPO_ROOT);
  app.locals.sync = sync;
  app.use(express.json({ limit: '2kb' }));

  function allowedSystems() {
    return fs.readdirSync(REPO_ROOT, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && isSystemName(entry.name))
      .map(entry => entry.name);
  }

  function systemPath(system) {
    if (!isSystemName(system) || !allowedSystems().includes(system)) return null;
    return resolveChild(REPO_ROOT, system, true);
  }

  // Serve frontend
  app.use(express.static(path.join(__dirname, 'public')));

  // List all systems with thumbnail counts
  app.get('/api/systems', (req, res) => {
    const downloadable = new Set(declaredSystems(REPO_ROOT));
    const entries = [...new Set([...allowedSystems(), ...downloadable])];
    const systems = [];
    for (const name of entries) {
      const sysPath = resolveChild(REPO_ROOT, name, true);
      if (!sysPath && !downloadable.has(name)) continue;
      let totalCount = 0;
      const types = {};
      for (const t of THUMB_TYPES) {
        const tPath = sysPath && resolveChild(sysPath, t, true);
        if (tPath) {
          const files = listPngs(tPath);
          types[t] = files.length;
          totalCount += files.length;
        }
      }
      if (totalCount > 0 || downloadable.has(name)) {
        systems.push({ name, types, total: totalCount, downloadable: downloadable.has(name) });
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

    const sysPath = systemPath(system);
    if (!sysPath) return res.status(400).json({ error: 'Invalid system' });

    const dirPath = resolveChild(sysPath, type, true);
    if (!dirPath) {
      return res.json({ thumbnails: [], total: 0, page, perPage });
    }

    const files = listPngs(dirPath);
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

    const sysPath = systemPath(system);
    if (!sysPath) return res.status(400).send('Invalid system');
    if (!isPng(file)) return res.status(400).send('Invalid thumbnail filename');

    const dirPath = resolveChild(sysPath, type, true);
    const filePath = dirPath && resolveChild(dirPath, file, false);
    if (!filePath) return res.status(404).send('Not found');
    res.sendFile(filePath);
  });

  app.get('/api/sync-status', (req, res) => res.json(sync.getStatus()));

  // Select one declared system to download, or update already-downloaded ones.
  // Return promptly; the UI follows completion through /api/sync-status.
  app.post('/api/sync', (req, res) => {
    try {
      res.status(202).json(sync.request(req.body?.system));
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  });

  return app;
}

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  const app = createApp();
  const server = app.listen(PORT, '0.0.0.0', () => {
    app.locals.sync.start({
      intervalSeconds: Number(process.env.SYNC_INTERVAL || 1800)
    });
    console.log(`Thumbnail browser running at http://0.0.0.0:${PORT}`);
  });
  let shuttingDown = false;
  // On real shutdown, stop any running sync, wait for it to settle, then
  // deinitialize all downloaded submodules so thumbnails don't persist.
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.locals.sync.stop();
    await app.locals.sync.wait();
    app.locals.sync.cleanup();
    server.close();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  // nodemon uses SIGUSR2 for restarts. Stop and reap the detached Git process
  // before allowing another server instance to start its own sync. Downloads
  // are preserved across restarts — only a real shutdown clears them.
  process.once('SIGUSR2', () => {
    app.locals.sync.stop();
    app.locals.sync.wait().finally(() => process.kill(process.pid, 'SIGUSR2'));
  });
}

module.exports = { createApp };
