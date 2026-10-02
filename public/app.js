const state = {
  systems: [],
  selectedSystem: null,
  selectedType: 'Named_Boxarts',
  page: 1,
  perPage: 60,
  total: 0,
  thumbnails: [],
  sync: null,
  submittingSync: false,
  submittingClear: false,
  thumbnailRequest: 0,
  syncRequest: 0,
  refreshedSyncRevision: null,
};

const THUMB_TYPES = [
  { key: 'Named_Boxarts', label: 'Box Art' },
  { key: 'Named_Titles', label: 'Title Screens' },
  { key: 'Named_Snaps', label: 'Gameplay Snaps' },
  { key: 'Named_Logos', label: 'Logos' },
];

// Elements
const systemList = document.getElementById('system-list');
const systemSearch = document.getElementById('system-search');
const currentSystem = document.getElementById('current-system');
const typeTabs = document.getElementById('type-tabs');
const thumbnailGrid = document.getElementById('thumbnail-grid');
const pagination = document.getElementById('pagination');
const emptyState = document.getElementById('empty-state');
const syncButton = document.getElementById('sync-system');
const clearButton = document.getElementById('clear-system');
const syncStatus = document.getElementById('sync-status');
const downloadWarning = document.getElementById('download-warning');

// Fetch systems
async function fetchSystems(quiet = false) {
  if (!quiet) systemList.innerHTML = '<div class="loading">Loading systems...</div>';
  try {
    const res = await fetch('/api/systems');
    if (!res.ok) throw new Error('Unable to load systems');
    const data = await res.json();
    state.systems = data.systems;
    renderSystems();
    renderSync();
    if (state.systems.length === 0) {
      systemList.innerHTML = '<div class="loading">No thumbnail systems are configured in this checkout.</div>';
    }
    return true;
  } catch (err) {
    systemList.innerHTML = '<div class="loading">Error loading systems. Reload to retry.</div>';
    return false;
  }
}

function renderSystems() {
  const query = systemSearch.value.toLowerCase();
  const filtered = state.systems.filter(s => s.name.toLowerCase().includes(query));

  systemList.innerHTML = filtered.map(s => `
    <div class="system-item ${state.selectedSystem === s.name ? 'active' : ''}" data-system="${escapeAttr(s.name)}">
      <span>${escapeHtml(s.name)}</span>
      <span class="count">${s.total || 'Download'}</span>
    </div>
  `).join('');

  document.querySelectorAll('.system-item').forEach(el => {
    el.addEventListener('click', () => {
      const name = el.getAttribute('data-system');
      selectSystem(name);
    });
  });
}

async function selectSystem(name) {
  state.selectedSystem = name;
  const system = state.systems.find(s => s.name === name);
  state.selectedType = THUMB_TYPES.find(t => system?.types[t.key] > 0)?.key || 'Named_Boxarts';
  state.page = 1;
  currentSystem.textContent = name;
  emptyState.classList.add('hidden');
  renderSystems();
  renderSync();
  renderTypeTabs();
  await fetchThumbnails();
}

function renderTypeTabs() {
  const sys = state.systems.find(s => s.name === state.selectedSystem);
  if (!sys) return;

  typeTabs.innerHTML = THUMB_TYPES.map(t => {
    const count = sys.types[t.key] || 0;
    if (count === 0) return '';
    return `
      <div class="type-tab ${state.selectedType === t.key ? 'active' : ''}" data-type="${t.key}">
        ${t.label}<span class="tab-count">${count}</span>
      </div>
    `;
  }).join('');

  document.querySelectorAll('.type-tab').forEach(el => {
    el.addEventListener('click', () => {
      state.selectedType = el.getAttribute('data-type');
      state.page = 1;
      renderTypeTabs();
      fetchThumbnails();
    });
  });
}

async function fetchThumbnails() {
  if (!state.selectedSystem) return;
  const requestId = ++state.thumbnailRequest;
  const system = state.systems.find(s => s.name === state.selectedSystem);
  if (system?.total === 0) {
    thumbnailGrid.innerHTML = '<div class="loading">Thumbnails are not downloaded yet. Use Download this system above.</div>';
    pagination.innerHTML = '';
    return;
  }
  thumbnailGrid.innerHTML = '<div class="loading">Loading thumbnails...</div>';
  pagination.innerHTML = '';

  const params = new URLSearchParams({
    system: state.selectedSystem,
    type: state.selectedType,
    page: state.page,
    perPage: state.perPage,
  });

  try {
    const res = await fetch('/api/thumbnails?' + params);
    if (!res.ok) throw new Error('Unable to load thumbnails');
    const data = await res.json();
    if (requestId !== state.thumbnailRequest) return;
    state.thumbnails = data.thumbnails;
    state.total = data.total;
    renderThumbnails();
    renderPagination();
  } catch (err) {
    if (requestId !== state.thumbnailRequest) return;
    thumbnailGrid.innerHTML = '<div class="loading">Error loading thumbnails.</div>';
  }
}

function renderThumbnails() {
  if (state.thumbnails.length === 0) {
    thumbnailGrid.innerHTML = '<div class="loading">No thumbnails in this category.</div>';
    return;
  }

  thumbnailGrid.innerHTML = state.thumbnails.map(file => {
    const imgUrl = `/img/${encodeURIComponent(state.selectedSystem)}/${encodeURIComponent(state.selectedType)}/${encodeURIComponent(file)}`;
    const displayName = file.replace(/\.png$/i, '');
    return `
      <div class="thumbnail-card" data-url="${escapeAttr(imgUrl)}" data-name="${escapeAttr(displayName)}">
        <img src="${imgUrl}" loading="lazy" alt="${escapeAttr(displayName)}" />
        <div class="card-name">${escapeHtml(displayName)}</div>
      </div>
    `;
  }).join('');

  document.querySelectorAll('.thumbnail-card').forEach(el => {
    el.addEventListener('click', () => {
      openLightbox(el.getAttribute('data-url'), el.getAttribute('data-name'));
    });
  });
}

function renderPagination() {
  const totalPages = Math.ceil(state.total / state.perPage);
  if (totalPages <= 1) {
    pagination.innerHTML = `<span class="page-info">${state.total} thumbnails</span>`;
    return;
  }

  pagination.innerHTML = `
    <button ${state.page <= 1 ? 'disabled' : ''} id="prev-page">← Prev</button>
    <span class="page-info">Page ${state.page} of ${totalPages} (${state.total} total)</span>
    <button ${state.page >= totalPages ? 'disabled' : ''} id="next-page">Next →</button>
  `;

  document.getElementById('prev-page')?.addEventListener('click', () => {
    if (state.page > 1) { state.page--; fetchThumbnails(); window.scrollTo(0, 0); }
  });
  document.getElementById('next-page')?.addEventListener('click', () => {
    if (state.page < totalPages) { state.page++; fetchThumbnails(); window.scrollTo(0, 0); }
  });
}

function openLightbox(url, name) {
  const lb = document.createElement('div');
  lb.className = 'lightbox';
  lb.innerHTML = `<img src="${url}" alt="${escapeAttr(name)}" /><div class="lb-name">${escapeHtml(name)}</div>`;
  lb.addEventListener('click', () => lb.remove());
  document.body.appendChild(lb);
}

function renderSync() {
  const system = state.systems.find(s => s.name === state.selectedSystem);
  syncButton.hidden = !system?.downloadable;
  clearButton.hidden = !system?.total;
  downloadWarning.hidden = !system?.downloadable || system.total > 0;
  syncButton.disabled = state.submittingSync || state.sync?.status === 'running';
  clearButton.disabled = state.submittingClear || state.sync?.status === 'running';
  syncButton.textContent = system?.total ? 'Update this system' : 'Download this system';
  if (state.sync?.status === 'running') {
    syncStatus.textContent = state.sync.system ? `Downloading ${state.sync.system}…` : 'Updating downloaded systems…';
  } else if (state.sync?.status === 'error') {
    syncStatus.textContent = `Download failed: ${state.sync.error} Select the system and retry.`;
  } else if (state.sync?.status === 'done') {
    syncStatus.textContent = 'Sync complete';
  } else {
    syncStatus.textContent = '';
  }
}

async function startSync() {
  if (!state.selectedSystem || state.submittingSync || state.sync?.status === 'running') return;
  state.submittingSync = true;
  const requestId = ++state.syncRequest;
  renderSync();
  try {
    const response = await fetch('/api/sync', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ system: state.selectedSystem })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Unable to start download');
    if (requestId !== state.syncRequest) return;
    state.sync = result;
    renderSync();
  } catch (err) {
    syncStatus.textContent = err.message;
  } finally {
    state.submittingSync = false;
    syncButton.disabled = state.sync?.status === 'running';
  }
}

async function pollSync() {
  const requestId = state.submittingSync ? null : ++state.syncRequest;
  try {
    if (requestId === null) return;
    const response = await fetch('/api/sync-status');
    if (!response.ok) throw new Error('Unable to check download status');
    const result = await response.json();
    if (requestId !== state.syncRequest) return;
    const refreshKey = JSON.stringify([result.revision, result.lastSync, result.error]);
    const changed = refreshKey !== state.refreshedSyncRevision;
    state.sync = result;
    renderSync();
    if (changed && ['done', 'error'].includes(result.status)) {
      if (!await fetchSystems(true)) return;
      state.refreshedSyncRevision = refreshKey;
      if (state.selectedSystem) {
        const system = state.systems.find(s => s.name === state.selectedSystem);
        if (!system?.types[state.selectedType]) {
          state.selectedType = THUMB_TYPES.find(t => system?.types[t.key] > 0)?.key || 'Named_Boxarts';
        }
        renderTypeTabs();
        await fetchThumbnails();
      }
    }
  } catch (err) {
    syncStatus.textContent = 'Cannot check download status. Retrying…';
  } finally {
    setTimeout(pollSync, 2000);
  }
}

async function clearContent() {
  if (!state.selectedSystem || state.submittingClear) return;
  if (!confirm(`Clear all downloaded content for ${state.selectedSystem}?`)) return;
  state.submittingClear = true;
  renderSync();
  try {
    const response = await fetch('/api/content', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ system: state.selectedSystem })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Unable to clear content');
    await fetchSystems(true);
    renderTypeTabs();
    await fetchThumbnails();
  } catch (err) {
    syncStatus.textContent = err.message;
  } finally {
    state.submittingClear = false;
    clearButton.disabled = state.sync?.status === 'running';
  }
}

// Helpers
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Event listeners
systemSearch.addEventListener('input', renderSystems);
syncButton.addEventListener('click', startSync);
clearButton.addEventListener('click', clearContent);

// Init
fetchSystems().then(pollSync);
