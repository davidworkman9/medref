const fs = require('fs');
const diagnoses = JSON.parse(fs.readFileSync('./src/diagnoses.json', 'utf8'));
const htmlShell = fs.readFileSync('./medref.htm', 'utf8');

// Build category list from diagnoses
const catSet = new Map();
const catColors = {
  'Cardiology': '#f43f5e',
  'Pulmonology': '#06b6d4',
  'Neurology': '#a855f7',
  'GI / Hepatology': '#f97316',
  'Infectious Disease': '#22c55e',
  'Endocrinology': '#eab308',
  'Nephrology': '#3b82f6',
  'Orthopedics': '#ec4899',
  'Emergency Medicine': '#f43f5e',
  'Hematology': '#ec4899',
  'Rheumatology': '#a855f7',
  'Obstetrics': '#ec4899',
  'Vascular Surgery': '#f43f5e',
};
let catId = 1;
diagnoses.forEach(d => {
  if (!catSet.has(d.cat)) {
    catSet.set(d.cat, { id: 'c' + catId, name: d.cat, color: catColors[d.cat] || '#06b6d4' });
    catId++;
  }
});
const categories = [...catSet.values()];

// Map diagnoses to app format
const dxData = diagnoses.map((d, i) => ({
  id: 'dx' + (i + 1),
  name: d.name,
  icd: d.icd,
  catId: catSet.get(d.cat).id,
  color: d.color,
  signs: d.signs,
  treatment: d.treatment,
  meds: d.meds,
  ddx: d.ddx,
  labs: d.labs,
  notes: d.notes,
  created: Date.now() - i * 1000,
  builtIn: true,
}));

const appJS = `
// ─── BUILT-IN DATA ───
const BUILTIN_DIAGNOSES = ${JSON.stringify(dxData)};
const BUILTIN_CATEGORIES = ${JSON.stringify(categories)};

// ─── CONSTANTS ───
const COLORS = ['#f97316','#06b6d4','#a855f7','#22c55e','#f43f5e','#eab308','#3b82f6','#ec4899','#14b8a6','#f59e0b'];
const SECTION_COLORS = {
  signs:     { bg: 'rgba(6,182,212,0.15)',   icon: '🩺', label: 'Signs & Symptoms' },
  treatment: { bg: 'rgba(34,197,94,0.15)',   icon: '💊', label: 'Treatment' },
  meds:      { bg: 'rgba(168,85,247,0.15)',  icon: '💉', label: 'Medications & Dosing' },
  labs:      { bg: 'rgba(249,115,22,0.15)',  icon: '🔬', label: 'Lab / Imaging Findings' },
  notes:     { bg: 'rgba(234,179,8,0.15)',   icon: '📌', label: 'Clinical Pearls' },
};

// ─── PERSISTENCE (localStorage + IndexedDB for embeddings) ───
function loadData() {
  try { return JSON.parse(localStorage.getItem('medref_data') || '{}'); } catch { return {}; }
}
function saveData(data) {
  localStorage.setItem('medref_data', JSON.stringify(data));
}

function getData() {
  let d = loadData();
  if (!d.categories || d.categories.length === 0) d.categories = [...BUILTIN_CATEGORIES];
  if (!d.diagnoses || d.diagnoses.length === 0) {
    d.diagnoses = BUILTIN_DIAGNOSES.map(dx => ({...dx}));
    saveData(d);
  }
  // Merge any new built-in diagnoses not already present
  const existingIds = new Set(d.diagnoses.map(x => x.id));
  BUILTIN_DIAGNOSES.forEach(bdx => {
    if (!existingIds.has(bdx.id)) {
      d.diagnoses.push({...bdx});
    }
  });
  // Merge any new categories
  const existingCatIds = new Set(d.categories.map(c => c.id));
  BUILTIN_CATEGORIES.forEach(bc => {
    if (!existingCatIds.has(bc.id)) d.categories.push({...bc});
  });
  if (!d.recent) d.recent = [];
  return d;
}

// ─── IndexedDB for embeddings ───
const DB_NAME = 'medref_embeddings';
const DB_VERSION = 1;
let embeddingDB = null;

function openEmbeddingDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('embeddings')) {
        db.createObjectStore('embeddings', { keyPath: 'id' });
      }
    };
    req.onsuccess = (e) => { embeddingDB = e.target.result; resolve(embeddingDB); };
    req.onerror = (e) => reject(e.target.error);
  });
}

function getEmbedding(id) {
  return new Promise((resolve, reject) => {
    const tx = embeddingDB.transaction('embeddings', 'readonly');
    const req = tx.objectStore('embeddings').get(id);
    req.onsuccess = () => resolve(req.result ? req.result.embedding : null);
    req.onerror = () => resolve(null);
  });
}

function putEmbedding(id, embedding) {
  return new Promise((resolve, reject) => {
    const tx = embeddingDB.transaction('embeddings', 'readwrite');
    tx.objectStore('embeddings').put({ id, embedding: Array.from(embedding) });
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

function getAllEmbeddings() {
  return new Promise((resolve) => {
    const tx = embeddingDB.transaction('embeddings', 'readonly');
    const req = tx.objectStore('embeddings').getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
  });
}

// ─── SEMANTIC SEARCH ENGINE ───
let semanticReady = false;
let extractor = null;
let embeddingCache = new Map(); // id -> Float32Array

function dxSearchText(dx) {
  return [dx.name, dx.icd, dx.signs, dx.ddx, dx.treatment, dx.meds, dx.labs, dx.notes].filter(Boolean).join(' ');
}

function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-8);
}

async function initSemanticSearch() {
  const badge = document.getElementById('ai-badge');
  badge.className = 'loading';
  badge.textContent = 'AI loading...';

  try {
    const { pipeline } = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.4.1');
    extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      dtype: 'q8',
    });

    badge.className = 'ready';
    badge.textContent = 'AI';

    // Load cached embeddings from IndexedDB
    const stored = await getAllEmbeddings();
    stored.forEach(e => { embeddingCache.set(e.id, new Float32Array(e.embedding)); });

    // Embed any diagnoses that don't have embeddings yet
    const d = getData();
    let newCount = 0;
    for (const dx of d.diagnoses) {
      if (!embeddingCache.has(dx.id)) {
        const text = dxSearchText(dx);
        const output = await extractor(text, { pooling: 'mean', normalize: true });
        const emb = new Float32Array(output.data);
        embeddingCache.set(dx.id, emb);
        await putEmbedding(dx.id, emb);
        newCount++;
        if (newCount % 10 === 0) {
          badge.textContent = 'AI ' + Math.round((newCount / d.diagnoses.length) * 100) + '%';
        }
      }
    }

    semanticReady = true;
    badge.textContent = 'AI ✓';
    setTimeout(() => { badge.textContent = 'AI'; }, 2000);

    // If there's a pending search, re-run it
    if (state.search) renderList();

  } catch (err) {
    console.error('Semantic search failed to load:', err);
    badge.className = 'off';
    badge.textContent = '';
  }
}

async function semanticSearch(query, diagnoses) {
  if (!semanticReady || !extractor) return null;
  try {
    const output = await extractor(query, { pooling: 'mean', normalize: true });
    const queryEmb = new Float32Array(output.data);

    const scored = diagnoses.map(dx => {
      const emb = embeddingCache.get(dx.id);
      if (!emb) return { dx, score: 0 };
      return { dx, score: cosineSim(queryEmb, emb) };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.filter(s => s.score > 0.15);
  } catch {
    return null;
  }
}

// ─── STATE ───
let state = {
  tab: 'browse',
  catFilter: 'all',
  search: '',
  editingId: null,
  selectedColor: COLORS[0],
  catPickColor: COLORS[0],
  viewingId: null,
  semanticResults: null,
  searchTimeout: null,
};

// ─── INIT ───
document.addEventListener('DOMContentLoaded', async () => {
  getData(); // ensure data initialized
  buildColorRow();
  buildCatPickRow();
  render();
  setupSearch();

  if (!localStorage.getItem('medref_banner_dismissed') && !isInstalled()) {
    setTimeout(() => document.getElementById('install-banner').classList.remove('hidden'), 2000);
  } else {
    document.getElementById('install-banner').classList.add('hidden');
  }

  // Init IndexedDB then semantic search
  try {
    await openEmbeddingDB();
    initSemanticSearch(); // fire and forget
  } catch (e) {
    console.error('IndexedDB error:', e);
  }
});

function isInstalled() {
  return window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
}
function dismissBanner() {
  localStorage.setItem('medref_banner_dismissed', '1');
  document.getElementById('install-banner').classList.add('hidden');
}
function uid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

// ─── RENDER ───
function render() {
  renderCategoryBar();
  renderList();
}

function renderCategoryBar() {
  const d = getData();
  const bar = document.getElementById('category-bar');
  if (state.tab !== 'category') { bar.innerHTML = ''; return; }
  let html = '<button class="cat-pill ' + (state.catFilter==='all'?'active':'') + '" style="' + (state.catFilter==='all'?'background:var(--accent2);border-color:var(--accent2);':'') + '" onclick="setCatFilter(\\'all\\')">All</button>';
  d.categories.forEach(cat => {
    const active = state.catFilter === cat.id;
    html += '<button class="cat-pill ' + (active?'active':'') + '" style="' + (active?'background:'+cat.color+';border-color:'+cat.color+';':'') + '" onclick="setCatFilter(\\'' + cat.id + '\\')">' + cat.name + '</button>';
  });
  html += '<button class="cat-pill" onclick="openCatManager()" style="border-style:dashed;">⚙ Manage</button>';
  bar.innerHTML = html;
}

function renderList() {
  const d = getData();
  const list = document.getElementById('dx-list');
  let diagnoses = [...d.diagnoses];

  // filter by search
  if (state.search) {
    const q = state.search.toLowerCase();

    // If we have semantic results, use them
    if (state.semanticResults && state.semanticResults.length > 0) {
      const resultIds = new Set(state.semanticResults.map(r => r.dx.id));
      // Also include substring matches
      const substringMatches = diagnoses.filter(dx =>
        !resultIds.has(dx.id) && (
          dx.name.toLowerCase().includes(q) ||
          (dx.icd||'').toLowerCase().includes(q) ||
          (dx.signs||'').toLowerCase().includes(q) ||
          (dx.ddx||'').toLowerCase().includes(q) ||
          (dx.meds||'').toLowerCase().includes(q) ||
          (dx.notes||'').toLowerCase().includes(q)
        )
      ).map(dx => ({ dx, score: 0.1 }));

      const combined = [...state.semanticResults, ...substringMatches];
      diagnoses = combined.map(r => ({...r.dx, _score: r.score}));
    } else {
      // Fallback to substring search
      diagnoses = diagnoses.filter(dx =>
        dx.name.toLowerCase().includes(q) ||
        (dx.icd||'').toLowerCase().includes(q) ||
        (dx.signs||'').toLowerCase().includes(q) ||
        (dx.ddx||'').toLowerCase().includes(q) ||
        (dx.meds||'').toLowerCase().includes(q) ||
        (dx.notes||'').toLowerCase().includes(q)
      );
    }
  }

  // filter by category
  if (state.tab === 'category' && state.catFilter !== 'all') {
    diagnoses = diagnoses.filter(dx => dx.catId === state.catFilter);
  }

  // recent tab
  if (state.tab === 'recent') {
    const recent = d.recent || [];
    diagnoses = recent.map(id => diagnoses.find(dx => dx.id === id)).filter(Boolean);
  }

  if (diagnoses.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🩻</div><div class="empty-state-title">' + (state.search ? 'No results found' : 'No diagnoses yet') + '</div><div class="empty-state-sub">' + (state.search ? 'Try a different search term' : 'Tap <strong>+ Add Dx</strong> to add your first diagnosis') + '</div></div>';
    return;
  }

  // If searching with semantic results, keep score order
  if (state.search && (state.semanticResults || []).length > 0) {
    list.innerHTML = diagnoses.map(dx => dxCardHTML(dx, d, dx._score)).join('');
    return;
  }

  if (state.tab === 'recent') {
    list.innerHTML = diagnoses.map(dx => dxCardHTML(dx, d)).join('');
    return;
  }

  // Sort A-Z and group
  diagnoses.sort((a, b) => a.name.localeCompare(b.name));
  const groups = {};
  diagnoses.forEach(dx => {
    const letter = dx.name[0].toUpperCase();
    if (!groups[letter]) groups[letter] = [];
    groups[letter].push(dx);
  });
  let html = '';
  Object.keys(groups).sort().forEach(letter => {
    html += '<div class="section-letter">' + letter + '</div>';
    groups[letter].forEach(dx => { html += dxCardHTML(dx, d); });
  });
  list.innerHTML = html;
}

function dxCardHTML(dx, d, score) {
  const cat = (d.categories || []).find(c => c.id === dx.catId);
  const color = dx.color || '#06b6d4';
  const scoreHTML = score && score > 0.15 ? '<span class="dx-score">' + Math.round(score * 100) + '% match</span>' : '';
  return '<div class="dx-card" onclick="openDetail(\\'' + dx.id + '\\')">' +
    '<div class="dx-card-header">' +
    '<div class="dx-color-bar" style="background:' + color + '"></div>' +
    '<div class="dx-card-info">' +
    '<div class="dx-name">' + escHtml(dx.name) + '</div>' +
    '<div class="dx-meta">' +
    (dx.icd ? '<span class="dx-icd">' + escHtml(dx.icd) + '</span>' : '') +
    (cat ? '<span class="dx-cat-badge" style="background:' + cat.color + '22;color:' + cat.color + '">' + escHtml(cat.name) + '</span>' : '') +
    '</div></div>' + scoreHTML +
    '<span class="dx-card-chevron">›</span>' +
    '</div></div>';
}

// ─── DETAIL ───
function openDetail(id) {
  const d = getData();
  const dx = d.diagnoses.find(x => x.id === id);
  if (!dx) return;
  state.viewingId = id;
  d.recent = [id, ...(d.recent||[]).filter(r => r !== id)].slice(0, 30);
  saveData(d);
  const cat = (d.categories || []).find(c => c.id === dx.catId);
  const color = dx.color || '#06b6d4';
  document.getElementById('detail-name').textContent = dx.name;
  let metaHTML = '';
  if (dx.icd) metaHTML += '<span class="dx-icd" style="font-size:13px;">' + escHtml(dx.icd) + '</span>';
  if (cat) metaHTML += '<span class="dx-cat-badge" style="background:' + cat.color + '22;color:' + cat.color + ';font-size:13px;">' + escHtml(cat.name) + '</span>';
  let bodyHTML = '<div class="detail-meta-row">' + metaHTML + '</div>';
  [{key:'signs',text:dx.signs},{key:'treatment',text:dx.treatment},{key:'meds',text:dx.meds},{key:'labs',text:dx.labs},{key:'notes',text:dx.notes}].forEach(({key,text}) => {
    if (!text) return;
    const sec = SECTION_COLORS[key];
    bodyHTML += '<div class="section-card"><div class="section-card-header" style="background:' + sec.bg + '"><div class="section-icon" style="background:' + sec.bg + '">' + sec.icon + '</div><div class="section-title">' + sec.label + '</div></div><div class="section-content">' + formatContent(text) + '</div></div>';
  });
  if (dx.ddx) {
    const items = dx.ddx.split(',').map(s => s.trim()).filter(Boolean);
    bodyHTML += '<div class="section-card"><div class="section-card-header" style="background:rgba(244,63,94,0.12)"><div class="section-icon" style="background:rgba(244,63,94,0.12)">⚖️</div><div class="section-title">Differential Diagnoses</div></div><div class="tag-list">' + items.map(i => '<span class="tag">' + escHtml(i) + '</span>').join('') + '</div></div>';
  }
  document.getElementById('detail-body').innerHTML = '<div style="height:5px;background:' + color + ';border-radius:12px;margin-bottom:16px;"></div>' + bodyHTML;
  document.getElementById('detail-view').classList.add('open');
}

function formatContent(text) {
  const lines = text.split('\\n').map(l => l.trim()).filter(Boolean);
  if (lines.length > 1) return '<ul>' + lines.map(l => '<li>' + escHtml(l) + '</li>').join('') + '</ul>';
  return escHtml(text);
}

function closeDetail() {
  state.viewingId = null;
  document.getElementById('detail-view').classList.remove('open');
  render();
}
function editCurrentDx() { if (state.viewingId) openModal(state.viewingId); }
function deleteCurrentDx() {
  if (!state.viewingId) return;
  if (!confirm('Delete this diagnosis?')) return;
  const d = getData();
  d.diagnoses = d.diagnoses.filter(x => x.id !== state.viewingId);
  d.recent = (d.recent||[]).filter(r => r !== state.viewingId);
  saveData(d);
  closeDetail();
}

// ─── MODAL ───
function openModal(editId) {
  state.editingId = editId || null;
  const d = getData();
  const sel = document.getElementById('f-cat');
  sel.innerHTML = '<option value="">— No category —</option>' + d.categories.map(c => '<option value="' + c.id + '">' + escHtml(c.name) + '</option>').join('');
  if (editId) {
    const dx = d.diagnoses.find(x => x.id === editId);
    if (dx) {
      document.getElementById('modal-title').textContent = 'Edit Diagnosis';
      document.getElementById('f-name').value = dx.name || '';
      document.getElementById('f-icd').value = dx.icd || '';
      document.getElementById('f-cat').value = dx.catId || '';
      document.getElementById('f-signs').value = dx.signs || '';
      document.getElementById('f-treatment').value = dx.treatment || '';
      document.getElementById('f-meds').value = dx.meds || '';
      document.getElementById('f-ddx').value = dx.ddx || '';
      document.getElementById('f-labs').value = dx.labs || '';
      document.getElementById('f-notes').value = dx.notes || '';
      state.selectedColor = dx.color || COLORS[0];
    }
  } else {
    document.getElementById('modal-title').textContent = 'New Diagnosis';
    ['f-name','f-icd','f-signs','f-treatment','f-meds','f-ddx','f-labs','f-notes'].forEach(id => document.getElementById(id).value = '');
    sel.value = '';
    state.selectedColor = COLORS[0];
  }
  updateColorSwatches();
  document.getElementById('modal-overlay').classList.add('open');
  setTimeout(() => document.getElementById('f-name').focus(), 300);
}
function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
  state.editingId = null;
}
async function saveDx() {
  const name = document.getElementById('f-name').value.trim();
  if (!name) { alert('Diagnosis name is required.'); return; }
  const d = getData();
  const record = {
    id: state.editingId || uid(),
    name,
    icd: document.getElementById('f-icd').value.trim(),
    catId: document.getElementById('f-cat').value,
    color: state.selectedColor,
    signs: document.getElementById('f-signs').value.trim(),
    treatment: document.getElementById('f-treatment').value.trim(),
    meds: document.getElementById('f-meds').value.trim(),
    ddx: document.getElementById('f-ddx').value.trim(),
    labs: document.getElementById('f-labs').value.trim(),
    notes: document.getElementById('f-notes').value.trim(),
    created: state.editingId ? (d.diagnoses.find(x=>x.id===state.editingId)||{}).created || Date.now() : Date.now(),
    updated: Date.now(),
  };
  if (state.editingId) {
    d.diagnoses = d.diagnoses.map(x => x.id === state.editingId ? record : x);
  } else {
    d.diagnoses.push(record);
  }
  saveData(d);

  // Generate embedding for new/edited diagnosis
  if (semanticReady && extractor) {
    try {
      const text = dxSearchText(record);
      const output = await extractor(text, { pooling: 'mean', normalize: true });
      const emb = new Float32Array(output.data);
      embeddingCache.set(record.id, emb);
      await putEmbedding(record.id, emb);
    } catch {}
  }

  closeModal();
  if (state.editingId) { state.viewingId = record.id; openDetail(record.id); }
  else { closeDetail(); render(); }
}

// ─── COLOR SWATCHES ───
function buildColorRow() {
  document.getElementById('color-row').innerHTML = COLORS.map(c =>
    '<div class="color-swatch ' + (c===state.selectedColor?'selected':'') + '" style="background:' + c + '" onclick="selectColor(\\'' + c + '\\')"></div>'
  ).join('');
}
function updateColorSwatches() {
  document.querySelectorAll('#color-row .color-swatch').forEach(el => {
    el.classList.toggle('selected', el.style.background === state.selectedColor || el.style.background === hexToRgb(state.selectedColor));
  });
}
function selectColor(c) {
  state.selectedColor = c;
  document.querySelectorAll('#color-row .color-swatch').forEach(el => {
    el.classList.toggle('selected', el.style.background === c || el.style.background === hexToRgb(c));
  });
}
function hexToRgb(hex) { return hex; }
function buildCatPickRow() {
  document.getElementById('cat-color-pick').innerHTML = COLORS.map(c =>
    '<div class="color-swatch ' + (c===state.catPickColor?'selected':'') + '" style="background:' + c + ';width:28px;height:28px;" onclick="selectCatColor(\\'' + c + '\\')"></div>'
  ).join('');
}
function selectCatColor(c) {
  state.catPickColor = c;
  document.querySelectorAll('#cat-color-pick .color-swatch').forEach(el => {
    el.classList.toggle('selected', el.style.background === c);
  });
}

// ─── TABS ───
function switchTab(tab) {
  state.tab = tab;
  state.catFilter = 'all';
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  render();
}
function setCatFilter(id) { state.catFilter = id; renderCategoryBar(); renderList(); }

// ─── SEARCH ───
function setupSearch() {
  const input = document.getElementById('search');
  input.addEventListener('input', (e) => {
    state.search = e.target.value.trim();

    // Always do immediate substring render
    state.semanticResults = null;
    renderList();

    // Debounce semantic search
    clearTimeout(state.searchTimeout);
    if (state.search && semanticReady) {
      state.searchTimeout = setTimeout(async () => {
        const d = getData();
        const results = await semanticSearch(state.search, d.diagnoses);
        if (results && state.search === e.target.value.trim()) {
          state.semanticResults = results;
          renderList();
        }
      }, 300);
    }
  });
}

// ─── CATEGORY MANAGER ───
function openCatManager() { renderCatManager(); document.getElementById('cat-manager').classList.add('open'); }
function closeCatManager() { document.getElementById('cat-manager').classList.remove('open'); render(); }
function renderCatManager() {
  const d = getData();
  const list = document.getElementById('cat-list');
  if (d.categories.length === 0) {
    list.innerHTML = '<div class="empty-state" style="padding:30px 0"><div class="empty-state-sub">No categories yet.</div></div>';
    return;
  }
  list.innerHTML = d.categories.map(cat =>
    '<div class="cat-item"><div class="cat-item-dot" style="background:' + cat.color + '"></div><div class="cat-item-name">' + escHtml(cat.name) + '</div><button class="cat-delete-btn" onclick="deleteCategory(\\'' + cat.id + '\\')">✕</button></div>'
  ).join('');
}
function addCategory() {
  const name = document.getElementById('new-cat-name').value.trim();
  if (!name) return;
  const d = getData();
  d.categories.push({ id: uid(), name, color: state.catPickColor });
  saveData(d);
  document.getElementById('new-cat-name').value = '';
  renderCatManager();
}
function deleteCategory(id) {
  if (!confirm('Delete this category? Diagnoses will not be deleted.')) return;
  const d = getData();
  d.categories = d.categories.filter(c => c.id !== id);
  d.diagnoses = d.diagnoses.map(dx => dx.catId === id ? {...dx, catId: ''} : dx);
  saveData(d);
  renderCatManager();
}

// ─── HELPERS ───
function escHtml(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── SERVICE WORKER ───
if ('serviceWorker' in navigator) {
  const swCode = \`
const CACHE = 'medref-v2';
const ASSETS = [location.href];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', e => { e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).catch(() => caches.match(e.request)))); });
\`;
  const blob = new Blob([swCode], { type: 'application/javascript' });
  navigator.serviceWorker.register(URL.createObjectURL(blob)).catch(() => {});
}
`;

// Build final HTML by replacing the placeholder script
const finalHTML = htmlShell.replace(
  '<script>\n// will be continued in next part\n</script>',
  '<script>\n' + appJS + '\n</script>'
);

fs.mkdirSync('./dist', { recursive: true });
fs.writeFileSync('./dist/medref.htm', finalHTML);
const sizeKB = Math.round(fs.statSync('./dist/medref.htm').size / 1024);
console.log('Built dist/medref.htm (' + sizeKB + 'KB) with ' + diagnoses.length + ' diagnoses');
