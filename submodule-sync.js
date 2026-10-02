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
function runGitCommand(repoRoot, args, onLog, timeoutMs, signal, captureStdout = false) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Sync cancelled'));
    if (timeoutMs <= 0) return reject(new Error('Download timed out after 10 minutes. Retry this system.'));
    const grouped = process.platform !== 'win32';
    const child = spawn('git', ['--literal-pathspecs', ...args], {
      cwd: repoRoot, detached: grouped, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    });
    let output = '';
    let timedOut = false;
    const kill = () => {
      try { grouped ? process.kill(-child.pid, 'SIGKILL') : child.kill('SIGKILL'); }
      catch (err) { if (err.code !== 'ESRCH') onLog(err.message); }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    signal?.addEventListener('abort', kill, { once: true });
    child.stdout.on('data', chunk => { if (captureStdout) output += chunk.toString(); else onLog(chunk.toString()); });
    child.stderr.on('data', chunk => onLog(chunk.toString()));
    child.once('error', err => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
      reject(err);
    });
    child.once('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
      if (signal?.aborted) reject(new Error('Sync cancelled'));
      else if (timedOut) reject(new Error('Download timed out after 10 minutes. Retry this system.'));
      else if (code !== 0) reject(new Error(`Git exited with code ${code}. Check the sync log and retry.`));
      else resolve(output);
    });
  });
}

async function runGit(repoRoot, systems, onLog, timeoutMs = 10 * 60 * 1000, signal) {
  if (!systems.length) return;
  // All preparation, initial clones and updates share the same job deadline.
  const deadline = Date.now() + timeoutMs;
  const git = (args, capture = false) => runGitCommand(repoRoot, args, onLog, deadline - Date.now(), signal, capture);
  const index = await git(['ls-files', '--stage', '-z', '--', ...systems], true);
  const records = index.split('\0').filter(Boolean).map(record => {
    const [mode, hash, stage] = record.slice(0, record.indexOf('\t')).split(' ');
    return { mode, hash, stage, path: record.slice(record.indexOf('\t') + 1) };
  });
  const gitlinks = new Set(records.filter(record => record.mode === '160000' && record.stage === '0').map(record => record.path));
  const missing = systems.filter(system => !gitlinks.has(system));
  if (missing.length) {
    // The small production image has .gitmodules but no source gitlinks/history.
    // Resolve a real commit and register only requested paths before cloning, so
    // later runs use the same native submodule update path. Never
    // initialize the whole catalogue or rewrite .gitmodules here.
    const config = await git(['config', '--file', '.gitmodules', '--null', '--get-regexp', '^submodule\\..*\\.(path|url|branch)$'], true);
    const declarations = new Map();
    for (const record of config.split('\0').filter(Boolean)) {
      const separator = record.indexOf('\n');
      const key = record.slice(0, separator);
      const suffix = key.lastIndexOf('.');
      const name = key.slice(10, suffix);
      if (!declarations.has(name)) declarations.set(name, {});
      declarations.get(name)[key.slice(suffix + 1)] = record.slice(separator + 1);
    }
    for (const system of missing) {
      const declaration = [...declarations.values()].find(entry => entry.path === system);
      if (!declaration || !declaredSystems(repoRoot).includes(system)) throw new Error('Select a system declared in .gitmodules');
      if (records.some(record => record.path === system || record.path.startsWith(system + '/'))) {
        throw new Error(`Refusing to replace tracked files for ${system}`);
      }
      if (!declaration.url) throw new Error(`Missing repository URL for ${system}`);
      const branch = declaration.branch === '.' ? (await git(['symbolic-ref', '--short', 'HEAD'], true)).trim() : declaration.branch;
      const ref = branch ? `refs/heads/${branch}` : 'HEAD';
      const remote = await git(['ls-remote', '--exit-code', '--', declaration.url, ref], true);
      const commit = remote.split('\n').map(line => line.split('\t')).find(([, name]) => name === ref)?.[0];
      if (!commit || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new Error(`Cannot resolve a commit for ${system}`);
      await git(['update-index', '--add', '--cacheinfo', '160000', commit, system]);
    }
  }
  // Include shallow branch tips so a declared main/master branch also works
  // when it differs from the remote's default branch. Paths stay explicit.
  await git(['submodule', 'update', '--init', '--remote', '--depth=1', '--no-single-branch', '--', ...systems]);
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

  return { request, start, getStatus: () => ({ ...status }), wait: () => active || Promise.resolve(), stop: () => { clearInterval(timer); controller?.abort(); } };
}

module.exports = { createSyncManager, declaredSystems, initialized, runGit };
