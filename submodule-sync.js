const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

// Only top-level, non-hidden system paths declared by the trusted repository.
function safeSystemName(name) {
  return typeof name === 'string' && name.length > 0 && !name.startsWith('.') &&
    !/[\\/:\x00-\x1f\x7f]/.test(name) && !['node_modules', 'public'].includes(name);
}

function declaredSystems(repoRoot) {
  const config = path.join(repoRoot, '.gitmodules');
  try {
    if (!fs.lstatSync(config).isFile()) return [];
    const output = execFileSync('git', ['config', '--file', config, '--null', '--get-regexp', '^submodule\\..*\\.path$'],
      { encoding: 'utf8', timeout: 5000 });
    return [...new Set(output.split('\0').filter(Boolean).map(record => record.slice(record.indexOf('\n') + 1)))]
      .filter(safeSystemName).filter(name => {
        try {
          if (!fs.lstatSync(path.join(repoRoot, name)).isDirectory()) return false;
          try { if (fs.lstatSync(path.join(repoRoot, name, '.git')).isSymbolicLink()) return false; }
          catch (err) { if (err.code !== 'ENOENT') return false; }
          return true;
        }
        catch (err) { return err.code === 'ENOENT'; }
      });
  } catch (err) {
    if (err.code === 'ENOENT' || err.status === 1) return [];
    throw err;
  }
}

function initialized(repoRoot, system) {
  try {
    const entry = fs.lstatSync(path.join(repoRoot, system, '.git'));
    return entry.isFile() || entry.isDirectory();
  } catch { return false; }
}

// Run an argument array, never a shell command. Kill the entire git process
// group on timeout so a stalled clone cannot keep running after a reported error.
function runGit(repoRoot, systems, onLog, timeoutMs = 10 * 60 * 1000, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Sync cancelled'));
    const grouped = process.platform !== 'win32';
    const child = spawn('git', ['--literal-pathspecs', 'submodule', 'update', '--init', '--remote', '--depth=1', '--', ...systems], {
      cwd: repoRoot, detached: grouped, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    });
    let timedOut = false;
    const kill = () => {
      try { grouped ? process.kill(-child.pid, 'SIGKILL') : child.kill('SIGKILL'); }
      catch (err) { if (err.code !== 'ESRCH') onLog(err.message); }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    signal?.addEventListener('abort', kill, { once: true });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => onLog(chunk.toString()));
    child.once('error', err => { clearTimeout(timer); reject(err); });
    child.once('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
      if (signal?.aborted) reject(new Error('Sync cancelled'));
      else if (timedOut) reject(new Error('Download timed out after 10 minutes. Retry this system.'));
      else if (code !== 0) reject(new Error(`Git exited with code ${code}. Check the sync log and retry.`));
      else resolve();
    });
  });
}

function createSyncManager(repoRoot, options = {}) {
  const execute = options.runGit || runGit;
  let active = null;
  let timer = null;
  let controller = null;
  let status = { status: 'idle', system: null, lastSync: null, error: null, log: '', revision: 0 };

  function request(system) {
    const known = declaredSystems(repoRoot);
    if (system !== undefined && !known.includes(system)) {
      const err = new Error('Select a system declared in .gitmodules');
      err.statusCode = 400;
      throw err;
    }
    if (active) {
      const err = new Error('A sync is already running. Please wait for it to finish.');
      err.statusCode = 409;
      throw err;
    }
    // A missing system means update downloaded systems only. Never initialize
    // every submodule as an accidental consequence of a blank API request.
    const systems = system === undefined ? known.filter(name => initialized(repoRoot, name)) : [system];
    status = { ...status, status: 'running', system: system || null, error: null, log: '', revision: status.revision + 1 };
    controller = new AbortController();
    active = Promise.resolve().then(() => {
      if (systems.length) return execute(repoRoot, systems, text => { status.log = (status.log + text).slice(-8000); }, undefined, controller.signal);
    }).then(() => {
      status = { ...status, status: 'done', lastSync: new Date().toISOString(), revision: status.revision + 1 };
    }, err => {
      status = { ...status, status: 'error', error: err.message, revision: status.revision + 1 };
    }).finally(() => { active = null; });
    return { ...status };
  }

  function start({ intervalSeconds = 1800 } = {}) {
    function automatic() {
      if (active) return;
      try {
        // Startup and periodic jobs never initialize missing collections.
        request();
      } catch (err) {
        status = { ...status, status: 'error', error: err.message, revision: status.revision + 1 };
      }
    }
    automatic();
    if (Number.isFinite(intervalSeconds) && intervalSeconds > 0) {
      timer = setInterval(automatic, intervalSeconds * 1000);
      timer.unref();
    }
  }

  function clear(system) {
    const known = declaredSystems(repoRoot);
    if (system === undefined || !known.includes(system)) {
      const err = new Error('Select a system declared in .gitmodules');
      err.statusCode = 400;
      throw err;
    }
    if (active) {
      const err = new Error('A sync is already running. Please wait for it to finish.');
      err.statusCode = 409;
      throw err;
    }
    if (!initialized(repoRoot, system)) {
      const err = new Error('This system has no downloaded content');
      err.statusCode = 400;
      throw err;
    }
    execFileSync('git', ['submodule', 'deinit', '-f', '--', system], { cwd: repoRoot, timeout: 30000, stdio: 'pipe' });
  }

  return { request, clear, start, getStatus: () => ({ ...status }), wait: () => active || Promise.resolve(), stop: () => { clearInterval(timer); controller?.abort(); } };
}

module.exports = { createSyncManager, declaredSystems, initialized, runGit };
