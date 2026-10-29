import * as pdfjsLib from './vendor/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const COLORS = ['#d6483a', '#f08c2b', '#e9c13b', '#4caf6a', '#2f9fb3', '#3f6fd8', '#8b5cd6', '#d65c9c'];

// ---------------------------------------------------------------------------
// Ajustes (preferencias por dispositivo)
// ---------------------------------------------------------------------------
const DEFAULTS = { paper: 'white', layout: 'auto', speed: '800', sound: 'on', hint: 'show' };
const settings = { ...DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem('lectura.settings') || '{}')); } catch {}
function saveSettings() {
  try { localStorage.setItem('lectura.settings', JSON.stringify(settings)); } catch {}
}

// ---------------------------------------------------------------------------
// Base de datos local (IndexedDB): libros + archivos PDF
// ---------------------------------------------------------------------------
let dbPromise;
function db() {
  return dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('lectura', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('books', { keyPath: 'id' });
      d.createObjectStore('files');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function run(stores, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(stores, mode);
    const req = fn(t);
    t.oncomplete = () => resolve(req && 'result' in req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transacción cancelada'));
  });
}
const store = {
  books: () => run('books', 'readonly', t => t.objectStore('books').getAll()),
  book: id => run('books', 'readonly', t => t.objectStore('books').get(id)),
  putBook: b => run('books', 'readwrite', t => t.objectStore('books').put(b)),
  file: id => run('files', 'readonly', t => t.objectStore('files').get(id)),
  add: (book, data) => run(['books', 'files'], 'readwrite', t => {
    t.objectStore('files').put(data, book.id);
    t.objectStore('books').put(book);
  }),
  remove: id => run(['books', 'files'], 'readwrite', t => {
    t.objectStore('files').delete(id);
    t.objectStore('books').delete(id);
  }),
};

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

// ---------------------------------------------------------------------------
// Utilidades de interfaz
// ---------------------------------------------------------------------------
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}
function busy(text) {
  $('#busy').hidden = !text;
  if (text) $('#busyText').textContent = text;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function openSheet(d) { if (!d.open) d.showModal(); }
// Cerrar hojas tocando fuera o con la X
$$('dialog.sheet').forEach(d => {
  d.addEventListener('click', e => { if (e.target === d) d.close(); });
  $$('[data-close]', d).forEach(b => b.addEventListener('click', () => d.close()));
});

function canvasToBlob(canvas, type = 'image/jpeg', q = 0.9) {
  return new Promise(res => canvas.toBlob(res, type, q));
}
async function renderPdfPage(page, targetWidth, maxPixels = 4.2e6) {
  const vp1 = page.getViewport({ scale: 1 });
  let scale = targetWidth / vp1.width;
  const area = vp1.width * vp1.height * scale * scale;
  if (area > maxPixels) scale *= Math.sqrt(maxPixels / area);
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const blob = await canvasToBlob(canvas);
  const w = canvas.width;
  canvas.width = canvas.height = 0; // libera memoria (importante en iOS)
  return { blob, w };
}

// ---------------------------------------------------------------------------
// Biblioteca
// ---------------------------------------------------------------------------
let coverUrls = [];
async function renderLibrary() {
  const books = (await store.books()).sort((a, b) => (b.opened || b.added) - (a.opened || a.added));
  coverUrls.forEach(URL.revokeObjectURL);
  coverUrls = [];
  const shelf = $('#shelf');
  shelf.innerHTML = '';
  $('#emptyState').hidden = books.length > 0;
  $('#libCount').textContent = books.length
    ? `${books.length} ${books.length === 1 ? 'libro' : 'libros'}`
    : 'Tu biblioteca';
  for (const b of books) {
    const url = b.cover ? URL.createObjectURL(b.cover) : '';
    if (url) coverUrls.push(url);
    const pct = b.pages > 1 ? Math.round((b.lastPage / (b.pages - 1)) * 100) : 0;
    const card = document.createElement('article');
    card.className = 'card';
    card.innerHTML = `
      <div class="cover">
        ${url ? `<img src="${url}" alt="">` : ''}
        <div class="progress"><i style="width:${pct}%"></i></div>
      </div>
      <button class="icon-btn more" aria-label="Opciones"><svg class="ic"><use href="#i-more"/></svg></button>
      <h4>${esc(b.title)}</h4>
      <div class="meta">
        <span>${b.lastPage > 0 ? `Pág. ${b.lastPage + 1} de ${b.pages}` : `${b.pages} páginas`}</span>
        ${b.bookmarks?.length ? `<span>· <svg class="ic"><use href="#i-bookmark"/></svg>${b.bookmarks.length}</span>` : ''}
      </div>`;
    card.addEventListener('click', e => {
      if (e.target.closest('.more')) openBookMenu(b);
      else openBook(b.id);
    });
    shelf.appendChild(card);
  }
}

async function importFiles(files) {
  let added = 0;
  try { await navigator.storage?.persist?.(); } catch {}
  for (const f of files) {
    if (!/pdf/i.test(f.type) && !/\.pdf$/i.test(f.name)) { toast(`“${f.name}” no es un PDF`); continue; }
    busy(`Importando “${f.name}”…`);
    try {
      const data = await f.arrayBuffer();
      const doc = await pdfjsLib.getDocument({ data: data.slice(0) }).promise;
      const first = await doc.getPage(1);
      const vp = first.getViewport({ scale: 1 });
      const { blob: cover } = await renderPdfPage(first, 420);
      const book = {
        id: uid(),
        title: f.name.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').trim() || 'Sin título',
        pages: doc.numPages,
        ratio: vp.width / vp.height,
        lastPage: 0,
        bookmarks: [],
        added: Date.now(),
        opened: 0,
        size: f.size,
        cover,
      };
      await doc.destroy();
      await store.add(book, data);
      added++;
    } catch (err) {
      console.error(err);
      toast(err?.name === 'PasswordException' ? `“${f.name}” tiene contraseña` : `No se pudo importar “${f.name}”`);
    }
  }
  busy(null);
  if (added) toast(added === 1 ? 'Libro añadido' : `${added} libros añadidos`);
  renderLibrary();
}

$('#fileInput').addEventListener('change', e => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length) importFiles(files);
});
// Arrastrar y soltar (iPad con Split View / computadora)
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
  e.preventDefault();
  if (!$('#library').hidden && e.dataTransfer?.files?.length) importFiles([...e.dataTransfer.files]);
});

let menuBook = null;
function openBookMenu(b) {
  menuBook = b;
  $('#bmTitle').textContent = b.title;
  $('#bmName').value = b.title;
  openSheet($('#bookMenu'));
}
$('#bmCancel').addEventListener('click', () => $('#bookMenu').close());
$('#bmSave').addEventListener('click', async () => {
  const name = $('#bmName').value.trim();
  if (name && menuBook) {
    const b = await store.book(menuBook.id);
    b.title = name;
    await store.putBook(b);
  }
  $('#bookMenu').close();
  renderLibrary();
});
$('#bmDelete').addEventListener('click', async () => {
  if (!menuBook) return;
  if (!confirm(`¿Eliminar “${menuBook.title}” y sus marcadores de este dispositivo?`)) return;
  await store.remove(menuBook.id);
  $('#bookMenu').close();
  toast('Libro eliminado');
  renderLibrary();
});

// Aviso de instalación (solo en Safari, fuera de la app instalada)
const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
$('#installHint').hidden = standalone || !isIOS || settings.hint === 'hide';
$('#hideHint').addEventListener('click', () => {
  settings.hint = 'hide';
  saveSettings();
  $('#installHint').hidden = true;
});

// ---------------------------------------------------------------------------
// Sonido de hoja (sintetizado, sin archivos)
// ---------------------------------------------------------------------------
let actx = null;
function unlockAudio() {
  if (settings.sound !== 'on') return;
  try {
    actx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
  } catch {}
}
function playFlip() {
  if (settings.sound !== 'on' || !actx) return;
  const now = actx.currentTime;
  const dur = 0.36;
  const len = Math.floor(actx.sampleRate * dur);
  const buf = actx.createBuffer(1, len, actx.sampleRate);
  const d = buf.getChannelData(0);
  let crackle = 0;
  for (let i = 0; i < len; i++) {
    const t = i / len;
    const env = Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.25)), 0.7) * (1 - t * 0.6);
    if (Math.random() < 0.004) crackle = 1;
    crackle *= 0.96;
    d[i] = (Math.random() * 2 - 1) * env * (0.55 + 0.45 * crackle);
  }
  const src = actx.createBufferSource();
  src.buffer = buf;
  const bp = actx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 0.6;
  bp.frequency.setValueAtTime(3200, now);
  bp.frequency.exponentialRampToValueAtTime(900, now + dur);
  const hp = actx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 350;
  const g = actx.createGain();
  g.gain.value = 0.32;
  src.connect(bp).connect(hp).connect(g).connect(actx.destination);
  src.start(now);
}

// ---------------------------------------------------------------------------
// Lector
// ---------------------------------------------------------------------------
const R = {
  book: null,
  doc: null,
  flip: null,
  mode: null, // 'single' | 'double'
  bookWidth: 0,
  pageEls: [],
  cache: new Map(), // índice -> { url, w }
  gen: 0,
  rendering: false,
  current: 0,
};
const reader = $('#reader');

async function openBook(id) {
  busy('Abriendo…');
  try {
    const [book, data] = await Promise.all([store.book(id), store.file(id)]);
    if (!book || !data) throw new Error('Libro no encontrado');
    R.gen++;
    R.book = book;
    R.doc = await pdfjsLib.getDocument({ data }).promise;
    R.outline = null;
    book.opened = Date.now();
    saveBook();
    $('#bookTitle').textContent = book.title;
    $('#slider').max = book.pages;
    $('#library').hidden = true;
    reader.hidden = false;
    reader.classList.remove('chrome-hidden');
    applyPaper();
    buildFlip(Math.min(book.lastPage || 0, book.pages - 1));
    history.pushState({ reader: true }, '');
  } catch (err) {
    console.error(err);
    toast('No se pudo abrir el libro');
  } finally {
    busy(null);
  }
}

function closeBook() {
  if (!R.book) return;
  flushSave();
  R.gen++;
  R.flip?.destroy();
  R.flip = null;
  R.doc?.destroy();
  R.doc = null;
  for (const c of R.cache.values()) URL.revokeObjectURL(c.url);
  R.cache.clear();
  R.pageEls = [];
  R.book = null;
  $('#bookHost').innerHTML = '';
  reader.hidden = true;
  $('#library').hidden = false;
  renderLibrary();
}
$('#btnBack').addEventListener('click', () => history.state?.reader ? history.back() : closeBook());
window.addEventListener('popstate', () => {
  if (!$('#zoom').hidden) { closeZoom(); return; }
  if (R.book) closeBook();
});

let saveTimer = null;
function saveBook() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 400);
}
function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (R.book) store.putBook(R.book).catch(err => console.error(err));
}
document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });
window.addEventListener('pagehide', flushSave);

// --- Medidas: una o dos páginas, y ancho del libro para que quepa en pantalla
function computeLayout() {
  const st = $('#stage');
  const aw = st.clientWidth;
  const ah = st.clientHeight;
  const r = R.book.ratio || 0.7;
  let mode = settings.layout;
  if (mode === 'auto') mode = aw > ah * 1.15 && aw >= 820 ? 'double' : 'single';
  if (R.book.pages < 2) mode = 'single';
  const w = mode === 'double' ? Math.min(aw, ah * r * 2) : Math.min(aw, ah * r);
  return { mode, width: Math.max(120, Math.floor(w)) };
}

function makePageEl(i) {
  const n = R.book.pages;
  const el = document.createElement('div');
  el.className = 'page';
  el.dataset.index = i;
  if (i === 0 || (i === n - 1 && n > 2)) el.dataset.density = 'hard';
  el.innerHTML = `<div class="page-inner"><div class="page-num">${i + 1}</div><img alt=""><div class="ribbon"></div></div>`;
  const c = R.cache.get(i);
  if (c) el.querySelector('img').src = c.url;
  return el;
}

function buildFlip(start) {
  const { mode, width } = computeLayout();
  R.flip?.destroy();
  R.mode = mode;
  R.bookWidth = width;
  reader.classList.toggle('single', mode === 'single');
  const host = $('#bookHost');
  host.innerHTML = '';
  const el = document.createElement('div');
  el.id = 'book';
  host.appendChild(el);
  R.pageEls = Array.from({ length: R.book.pages }, (_, i) => makePageEl(i));

  const h = 1000;
  const w = Math.round(h * (R.book.ratio || 0.7));
  R.flip = new St.PageFlip(el, {
    width: w,
    height: h,
    size: 'stretch',
    // minWidth decide el modo: si el ancho del libro < 2·minWidth se muestra una sola página
    minWidth: mode === 'double' ? 40 : 100000,
    maxWidth: 100000,
    minHeight: 40,
    maxHeight: 100000,
    showCover: true,
    usePortrait: true,
    autoSize: true,
    drawShadow: true,
    maxShadowOpacity: 0.6,
    flippingTime: Number(settings.speed) || 800,
    startPage: start,
    mobileScrollSupport: false,
    disableFlipByClick: true,
    showPageCorners: true,
    swipeDistance: 30,
  });
  R.flip.loadFromHTML(R.pageEls);
  el.style.minWidth = '0';
  el.style.maxWidth = 'none';
  el.style.width = width + 'px';
  R.flip.update();

  R.flip.on('flip', e => onPage(e.data));
  R.flip.on('changeState', e => { if (e.data === 'flipping') playFlip(); });
  R.current = -1;
  onPage(R.flip.getCurrentPageIndex());
  refreshMarks();
}

function relayout() {
  if (!R.book || !R.flip) return;
  const { mode, width } = computeLayout();
  if (mode !== R.mode) {
    buildFlip(R.current);
  } else if (width !== R.bookWidth) {
    R.bookWidth = width;
    $('#book').style.width = width + 'px';
    R.flip.update();
    queueRender();
  }
}
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(relayout, 150);
});

function visiblePages(i = R.current) {
  const n = R.book.pages;
  if (R.mode !== 'double' || i === 0) return [i];
  // con portada sola, las dobles empiezan en páginas impares (índices 1-2, 3-4…)
  const left = i % 2 === 1 ? i : i - 1;
  return [left, left + 1].filter(p => p >= 0 && p < n);
}

function onPage(i) {
  if (i == null || i < 0) return;
  const changed = i !== R.current;
  R.current = i;
  const vis = visiblePages(i);
  if (changed) {
    R.book.lastPage = vis[0];
    saveBook();
  }
  const n = R.book.pages;
  $('#pageNo').textContent = vis.length > 1 ? `${vis[0] + 1}-${vis[1] + 1} / ${n}` : `${vis[0] + 1} / ${n}`;
  $('#slider').value = vis[0] + 1;
  updateMarkButton();
  queueRender();
}

// --- Renderizado perezoso de páginas cercanas
function wantedPages() {
  const n = R.book.pages;
  const vis = visiblePages();
  const ahead = R.mode === 'double' ? 4 : 2;
  const list = [...vis];
  for (let d = 1; d <= ahead; d++) {
    list.push(vis[vis.length - 1] + d, vis[0] - d);
  }
  return list.filter((p, k) => p >= 0 && p < n && list.indexOf(p) === k);
}
function targetWidth() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const pageCss = R.mode === 'double' ? R.bookWidth / 2 : R.bookWidth;
  return Math.ceil(pageCss * dpr);
}
function queueRender() {
  if (!R.rendering) renderLoop();
}
async function renderLoop() {
  R.rendering = true;
  const gen = R.gen;
  try {
    while (R.book && gen === R.gen) {
      const tw = targetWidth();
      const next = wantedPages().find(p => {
        const c = R.cache.get(p);
        return !c || c.w < tw * 0.85;
      });
      if (next == null) break;
      const page = await R.doc.getPage(next + 1);
      const { blob, w } = await renderPdfPage(page, tw);
      page.cleanup();
      if (gen !== R.gen) return;
      const url = URL.createObjectURL(blob);
      const old = R.cache.get(next);
      R.cache.set(next, { url, w: Math.max(w, tw * 0.85) });
      const img = R.pageEls[next]?.querySelector('img');
      if (img) img.src = url;
      if (old) setTimeout(() => URL.revokeObjectURL(old.url), 1000);
    }
    evict();
  } catch (err) {
    console.error(err);
  } finally {
    R.rendering = false;
  }
}
function evict() {
  const keep = R.mode === 'double' ? 10 : 7;
  for (const [p, c] of R.cache) {
    if (Math.abs(p - R.current) > keep) {
      R.pageEls[p]?.querySelector('img')?.removeAttribute('src');
      URL.revokeObjectURL(c.url);
      R.cache.delete(p);
    }
  }
}

// --- Navegación
function goTo(p, animate = true) {
  if (!R.flip) return;
  p = Math.max(0, Math.min(R.book.pages - 1, p));
  if (visiblePages().includes(p)) return;
  if (animate) {
    animated(f => f.flip(p));
  } else {
    R.flip.turnToPage(p);
    onPage(R.flip.getCurrentPageIndex());
  }
}
// La librería ignora los giros programáticos fuera de las esquinas cuando
// disableFlipByClick está activo (p. ej. "anterior" en modo de una página),
// así que lo desactivamos solo durante nuestras llamadas.
function animated(fn) {
  if (!R.flip) return;
  const s = R.flip.getSettings();
  s.disableFlipByClick = false;
  try { fn(R.flip); } finally { s.disableFlipByClick = true; }
}
const next = () => animated(f => f.flipNext());
const prev = () => animated(f => f.flipPrev());
$('#btnNext').addEventListener('click', next);
$('#btnPrev').addEventListener('click', prev);

document.addEventListener('keydown', e => {
  if (reader.hidden || document.querySelector('dialog[open]') || !$('#zoom').hidden) return;
  if (['ArrowRight', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); next(); }
  if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); prev(); }
});

// Toques: bordes = pasar página, centro = mostrar/ocultar controles.
// (Arrastrar una esquina o deslizar lo maneja la librería del efecto de hoja.)
let tap = null;
const stage = $('#stage');
stage.addEventListener('pointerdown', e => {
  unlockAudio();
  tap = { x: e.clientX, y: e.clientY, t: performance.now() };
});
stage.addEventListener('pointerup', e => {
  if (!tap || !R.flip) return;
  const moved = Math.hypot(e.clientX - tap.x, e.clientY - tap.y);
  const dt = performance.now() - tap.t;
  tap = null;
  if (moved > 10 || dt > 230) return;
  if (R.flip.getState() !== 'read') return;
  const rx = e.clientX / window.innerWidth;
  if (rx < 0.25) prev();
  else if (rx > 0.75) next();
  else reader.classList.toggle('chrome-hidden');
});
reader.addEventListener('pointerdown', unlockAudio, { capture: true });

// Barra deslizante
const slider = $('#slider');
const bubble = $('#scrubBubble');
slider.addEventListener('input', () => {
  bubble.hidden = false;
  const p = Number(slider.value);
  const mark = R.book.bookmarks.find(b => b.page === p - 1);
  bubble.textContent = `Página ${p}${mark ? ` · ${mark.name}` : ''}`;
});
slider.addEventListener('change', () => {
  bubble.hidden = true;
  goTo(Number(slider.value) - 1, false);
});

// ---------------------------------------------------------------------------
// Marcadores
// ---------------------------------------------------------------------------
function marksOn(pages) {
  return R.book.bookmarks.filter(b => pages.includes(b.page));
}
function updateMarkButton() {
  const m = marksOn(visiblePages())[0];
  const btn = $('#btnMark');
  btn.classList.toggle('on', !!m);
  btn.style.setProperty('--on', m ? m.color : '');
  btn.setAttribute('aria-label', m ? `Marcador: ${m.name}` : 'Marcar esta página');
}
function refreshMarks() {
  const byPage = new Map();
  for (const b of [...R.book.bookmarks].sort((a, b) => a.created - b.created)) {
    if (!byPage.has(b.page)) byPage.set(b.page, b);
  }
  R.pageEls.forEach((el, i) => {
    const m = byPage.get(i);
    el.classList.toggle('marked', !!m);
    el.querySelector('.ribbon').style.setProperty('--rib', m ? m.color : 'transparent');
  });
  const n = R.book.pages;
  $('#ticks').innerHTML = [...byPage.values()]
    .map(b => `<i style="left:${n > 1 ? (b.page / (n - 1)) * 100 : 0}%;background:${b.color}"></i>`)
    .join('');
  updateMarkButton();
}

let editing = null; // marcador en edición (o null para uno nuevo)
let pickedColor = COLORS[0];
function buildSwatches() {
  $('#mColors').innerHTML = COLORS.map(c =>
    `<button type="button" class="swatch" style="--c:${c}" data-c="${c}" aria-label="Color ${c}" aria-pressed="${c === pickedColor}"></button>`
  ).join('');
}
$('#mColors').addEventListener('click', e => {
  const s = e.target.closest('.swatch');
  if (!s) return;
  pickedColor = s.dataset.c;
  $$('.swatch', $('#mColors')).forEach(b => b.setAttribute('aria-pressed', b.dataset.c === pickedColor));
});

function openMarkDialog(mark, page) {
  editing = mark || null;
  const p = mark ? mark.page : page;
  pickedColor = mark ? mark.color : (localStorageGet('lectura.lastColor') || COLORS[0]);
  $('#markDialogTitle').textContent = mark ? 'Editar marcador' : 'Nuevo marcador';
  $('#mName').value = mark ? mark.name : '';
  $('#mName').placeholder = `Página ${p + 1}`;
  $('#mPage').value = p + 1;
  $('#mPage').max = R.book.pages;
  $('#mNote').value = mark ? mark.note || '' : '';
  $('#mDelete').hidden = !mark;
  buildSwatches();
  openSheet($('#markDialog'));
}
function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }

$('#btnMark').addEventListener('click', () => {
  const vis = visiblePages();
  const existing = marksOn(vis)[0];
  openMarkDialog(existing, vis[vis.length - 1] === R.book.pages - 1 && vis.length > 1 ? vis[1] : vis[0]);
});
$('#mCancel').addEventListener('click', () => $('#markDialog').close());
$('#markForm').addEventListener('submit', e => {
  e.preventDefault();
  const page = Math.max(1, Math.min(R.book.pages, parseInt($('#mPage').value, 10) || R.current + 1)) - 1;
  const data = {
    page,
    name: $('#mName').value.trim() || `Página ${page + 1}`,
    color: pickedColor,
    note: $('#mNote').value.trim(),
  };
  if (editing) Object.assign(editing, data);
  else R.book.bookmarks.push({ id: uid(), created: Date.now(), ...data });
  try { localStorage.setItem('lectura.lastColor', pickedColor); } catch {}
  saveBook();
  refreshMarks();
  $('#markDialog').close();
  if ($('#marksSheet').open) renderMarkList();
  toast(editing ? 'Marcador actualizado' : 'Marcador guardado');
});
$('#mDelete').addEventListener('click', () => {
  if (!editing) return;
  R.book.bookmarks = R.book.bookmarks.filter(b => b !== editing);
  saveBook();
  refreshMarks();
  $('#markDialog').close();
  if ($('#marksSheet').open) renderMarkList();
  toast('Marcador eliminado');
});

let markFilter = null;
function renderMarkList() {
  const marks = [...R.book.bookmarks].sort((a, b) => a.page - b.page || a.created - b.created);
  const used = COLORS.filter(c => marks.some(m => m.color === c));
  if (markFilter && !used.includes(markFilter)) markFilter = null;
  $('#markFilter').innerHTML = used.length > 1
    ? `<button class="chip" data-c="" aria-pressed="${!markFilter}">Todos</button>` +
      used.map(c => `<button class="chip" data-c="${c}" aria-pressed="${markFilter === c}"><i style="--c:${c}"></i>${marks.filter(m => m.color === c).length}</button>`).join('')
    : '';
  const shown = markFilter ? marks.filter(m => m.color === markFilter) : marks;
  const fmt = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', year: 'numeric' });
  $('#markList').innerHTML = shown.length
    ? shown.map(m => `
      <li data-id="${m.id}">
        <span class="dot" style="--c:${m.color}"></span>
        <div class="body">
          <div class="name">${esc(m.name)}</div>
          ${m.note ? `<div class="note">${esc(m.note)}</div>` : ''}
          <div class="pg">${fmt.format(m.created)}</div>
        </div>
        <span class="pg">Pág. ${m.page + 1}</span>
        <button class="icon-btn" data-edit aria-label="Editar"><svg class="ic"><use href="#i-edit"/></svg></button>
      </li>`).join('')
    : `<li class="empty-row">Aún no tienes marcadores en este libro.<br>Toca la cinta <svg class="ic" style="vertical-align:-5px"><use href="#i-bookmark"/></svg> para marcar la página que estás leyendo.</li>`;
}
$('#btnMarks').addEventListener('click', () => { renderMarkList(); openSheet($('#marksSheet')); });
$('#markFilter').addEventListener('click', e => {
  const c = e.target.closest('.chip');
  if (!c) return;
  markFilter = c.dataset.c || null;
  renderMarkList();
});
$('#markList').addEventListener('click', e => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  const m = R.book.bookmarks.find(b => b.id === li.dataset.id);
  if (!m) return;
  if (e.target.closest('[data-edit]')) { openMarkDialog(m); return; }
  $('#marksSheet').close();
  goTo(m.page);
});

// ---------------------------------------------------------------------------
// Índice del PDF
// ---------------------------------------------------------------------------
async function loadOutline() {
  if (R.outline) return R.outline;
  const flat = [];
  const doc = R.doc;
  async function walk(items, lvl) {
    for (const it of items || []) {
      let page = null;
      try {
        let dest = it.dest;
        if (typeof dest === 'string') dest = await doc.getDestination(dest);
        if (Array.isArray(dest) && dest[0] != null) {
          page = typeof dest[0] === 'number' ? dest[0] : await doc.getPageIndex(dest[0]);
        }
      } catch {}
      flat.push({ title: it.title, page, lvl });
      if (it.items?.length && lvl < 4) await walk(it.items, lvl + 1);
    }
  }
  try { await walk(await doc.getOutline(), 0); } catch {}
  R.outline = flat;
  return flat;
}
$('#btnToc').addEventListener('click', async () => {
  $('#gotoInput').max = R.book.pages;
  $('#gotoInput').placeholder = `1 – ${R.book.pages}`;
  $('#gotoInput').value = '';
  $('#tocList').innerHTML = '<li class="empty-row">Cargando…</li>';
  openSheet($('#tocSheet'));
  const items = await loadOutline();
  $('#tocList').innerHTML = items.length
    ? items.map((it, k) => `
      <li data-k="${k}" data-lvl="${it.lvl}" style="--lvl:${it.lvl}">
        <div class="body"><div class="name">${esc(it.title)}</div></div>
        ${it.page != null ? `<span class="pg">${it.page + 1}</span>` : ''}
      </li>`).join('')
    : '<li class="empty-row">Este PDF no trae índice. Usa “Ir a la página” o tus marcadores.</li>';
});
$('#tocList').addEventListener('click', e => {
  const li = e.target.closest('li[data-k]');
  const it = li && R.outline[Number(li.dataset.k)];
  if (!it || it.page == null) return;
  $('#tocSheet').close();
  goTo(it.page);
});
$('#gotoForm').addEventListener('submit', e => {
  e.preventDefault();
  const p = parseInt($('#gotoInput').value, 10);
  if (!p) return;
  $('#tocSheet').close();
  goTo(p - 1);
});

// ---------------------------------------------------------------------------
// Ajustes de lectura
// ---------------------------------------------------------------------------
function applyPaper() { reader.dataset.paper = settings.paper; }
function syncSettingsUI() {
  $$('#settingsSheet .seg').forEach(seg => {
    const key = seg.dataset.setting;
    $$('button', seg).forEach(b => b.setAttribute('aria-pressed', b.dataset.v === String(settings[key])));
  });
}
$('#btnSettings').addEventListener('click', () => { syncSettingsUI(); openSheet($('#settingsSheet')); });
$('#settingsSheet').addEventListener('click', e => {
  const b = e.target.closest('.seg button');
  if (!b) return;
  const key = b.closest('.seg').dataset.setting;
  settings[key] = b.dataset.v;
  saveSettings();
  syncSettingsUI();
  if (key === 'paper') applyPaper();
  if (key === 'layout') buildFlip(R.current);
  if (key === 'speed' && R.flip) R.flip.getSettings().flippingTime = Number(settings.speed);
  if (key === 'sound' && settings.sound === 'on') { unlockAudio(); playFlip(); }
});

// ---------------------------------------------------------------------------
// Lupa (zoom de la página actual)
// ---------------------------------------------------------------------------
const Z = { page: 0, scale: 1, url: null, gen: 0 };
const zoomEl = $('#zoom');
const zScroll = $('#zoomScroll');
const zImg = $('#zoomImg');

async function showZoomPage(p) {
  Z.page = Math.max(0, Math.min(R.book.pages - 1, p));
  const gen = ++Z.gen;
  busy('Preparando lupa…');
  try {
    const page = await R.doc.getPage(Z.page + 1);
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const { blob } = await renderPdfPage(page, zScroll.clientWidth * dpr * 2.5, 12e6);
    page.cleanup();
    if (gen !== Z.gen) return;
    if (Z.url) URL.revokeObjectURL(Z.url);
    Z.url = URL.createObjectURL(blob);
    zImg.src = Z.url;
    setZoom(1);
    zScroll.scrollTo(0, 0);
  } catch (err) {
    console.error(err);
    toast('No se pudo ampliar la página');
  } finally {
    busy(null);
  }
}
function setZoom(s, cx = zScroll.clientWidth / 2, cy = zScroll.clientHeight / 2) {
  const old = Z.scale;
  Z.scale = Math.max(1, Math.min(5, s));
  const fx = (zScroll.scrollLeft + cx) / old;
  const fy = (zScroll.scrollTop + cy) / old;
  zImg.style.width = zScroll.clientWidth * Z.scale + 'px';
  zScroll.scrollLeft = fx * Z.scale - cx;
  zScroll.scrollTop = fy * Z.scale - cy;
  $('#zLabel').textContent = Math.round(Z.scale * 100) + '%';
}
function openZoom() {
  zoomEl.hidden = false;
  history.pushState({ reader: true, zoom: true }, '');
  showZoomPage(visiblePages()[0]);
}
function closeZoom() {
  zoomEl.hidden = true;
  if (Z.url) { URL.revokeObjectURL(Z.url); Z.url = null; }
  zImg.removeAttribute('src');
  goTo(Z.page, false);
}
$('#btnZoom').addEventListener('click', openZoom);
$('#zClose').addEventListener('click', () => history.state?.zoom ? history.back() : closeZoom());
$('#zIn').addEventListener('click', () => setZoom(Z.scale * 1.4));
$('#zOut').addEventListener('click', () => setZoom(Z.scale / 1.4));
$('#zPrev').addEventListener('click', () => showZoomPage(Z.page - 1));
$('#zNext').addEventListener('click', () => showZoomPage(Z.page + 1));
// Pellizcar para ampliar (Safari en iPhone/iPad)
let gStart = 1;
zScroll.addEventListener('gesturestart', e => { e.preventDefault(); gStart = Z.scale; });
zScroll.addEventListener('gesturechange', e => { e.preventDefault(); setZoom(gStart * e.scale, e.clientX, e.clientY); });
zScroll.addEventListener('gestureend', e => e.preventDefault());
// Doble toque: alternar 100% / 250%
let lastTap = 0;
zScroll.addEventListener('pointerup', e => {
  const now = performance.now();
  if (now - lastTap < 300) {
    const r = zScroll.getBoundingClientRect();
    setZoom(Z.scale > 1.2 ? 1 : 2.5, e.clientX - r.left, e.clientY - r.top);
    lastTap = 0;
  } else lastTap = now;
});
// Ctrl + rueda / trackpad en computadora
zScroll.addEventListener('wheel', e => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  const r = zScroll.getBoundingClientRect();
  setZoom(Z.scale * Math.exp(-e.deltaY / 200), e.clientX - r.left, e.clientY - r.top);
}, { passive: false });

// Evita el zoom de la página completa en iOS fuera de la lupa
document.addEventListener('gesturestart', e => { if (zoomEl.hidden) e.preventDefault(); });

// ---------------------------------------------------------------------------
// Inicio
// ---------------------------------------------------------------------------
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').catch(err => console.warn('SW', err));
}
renderLibrary().catch(err => {
  console.error(err);
  toast('No se pudo abrir la biblioteca local');
});

// Para pruebas automatizadas
window.__lectura = { R, importFiles, openBook, closeBook, goTo };
