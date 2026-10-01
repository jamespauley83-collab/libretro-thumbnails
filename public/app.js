const state = {
  systems: [],
  selectedSystem: null,
  selectedType: 'Named_Boxarts',
  page: 1,
  perPage: 60,
  total: 0,
  thumbnails: [],
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

// Fetch systems
async function fetchSystems() {
  systemList.innerHTML = '<div class="loading">Loading systems...</div>';
  try {
    const res = await fetch('/api/systems');
    const data = await res.json();
    state.systems = data.systems;
    renderSystems();
    if (state.systems.length === 0) {
      systemList.innerHTML = '<div class="loading">No systems found. Submodules may not be initialized.</div>';
    }
  } catch (err) {
    systemList.innerHTML = '<div class="loading">Error loading systems.</div>';
  }
}

function renderSystems() {
  const query = systemSearch.value.toLowerCase();
  const filtered = state.systems.filter(s => s.name.toLowerCase().includes(query));

  systemList.innerHTML = filtered.map(s => `
    <div class="system-item ${state.selectedSystem === s.name ? 'active' : ''}" data-system="${escapeAttr(s.name)}">
      <span>${escapeHtml(s.name)}</span>
      <span class="count">${s.total}</span>
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
  state.selectedType = 'Named_Boxarts';
  state.page = 1;
  currentSystem.textContent = name;
  emptyState.classList.add('hidden');
  renderSystems();
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
    const data = await res.json();
    state.thumbnails = data.thumbnails;
    state.total = data.total;
    renderThumbnails();
    renderPagination();
  } catch (err) {
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

// Helpers
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
function escapeAttr(str) {
  return str.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Event listeners
systemSearch.addEventListener('input', renderSystems);

// Init
fetchSystems();
