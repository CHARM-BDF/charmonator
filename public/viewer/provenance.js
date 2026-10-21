// public/viewer/provenance.js -- see docs/provenance-viewer.md.
//
// Query parameters:
//   data       same-origin URL of the view JSON (required)
//   replay_ms  reveal pages one at a time, this many ms apart (a stage replay)
//   poll_ms    while status is "running", refetch this often (default 3000); pages and
//              facts that have arrived are shown as they come
//   doc, page  page to open first (document index from 0, page number)
//   theme      light | dark
//   highlight  boxes on the page image, where a document has locate_url:
//              select (default) for the selected fact or table source only,
//              auto for every fact on the page, off for none
//   parent_origin  when framed, post events to the host page at this origin
//              (status, complete, page, fact, source; see docs/provenance-viewer.md)

const params = new URLSearchParams(location.search);
const $ = id => document.getElementById(id);

const state = {
  data: null,
  order: [],            // [{ doc, page }] in reading order
  cursor: 0,            // index into order of the page shown
  revealed: Infinity,   // pages revealed so far (replay)
  activeFact: null,
  activeQuote: null,    // a quote chosen from the tables view
  tab: 'pages',
  playing: false,
  follow: false,        // while running: keep showing the newest page
  timer: null,
  pdfs: new Map(),      // document index -> Promise<PDFDocumentProxy>
  renderSeq: 0,
  rendered: null,       // "doc:page:width" now on the canvas
  renderTask: null,
  highlight: ['auto', 'select', 'off'].includes(params.get('highlight')) ? params.get('highlight') : 'select',
  boxes: new Map(),     // "doc#page" -> Map(quote -> box | null)
  locating: new Set(),  // "doc#page#quote" requests in flight
  dataUrl: null,        // documents' pdf_url and locate_url resolve against this
  lastStatus: null,     // events to a host page: the last status sent,
  completeSent: false,  // whether 'complete' was sent,
  notifiedPage: null    // and the last page reported
};

if (params.get('debug') === '1') window.__provenance = state;   // for inspection only

if (params.get('theme') === 'light' || params.get('theme') === 'dark') {
  document.documentElement.dataset.theme = params.get('theme');
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c !== null && c !== undefined && c !== false) node.append(c instanceof Node ? c : String(c));
  }
  return node;
}

function sameOriginUrl(raw, base = location.href) {
  if (!raw) return null;
  try {
    const u = new URL(raw, base);
    return u.origin === location.origin ? u.href : null;
  } catch {
    return null;
  }
}

// ---- events to a host page -------------------------------------------------

// Only to the origin the embedder names, never '*': the events carry document text.
const parentOrigin = (() => {
  const raw = params.get('parent_origin');
  if (!raw || window.parent === window) return null;
  try {
    const u = new URL(raw);
    return u.origin === raw.replace(/\/$/, '') ? u.origin : null;
  } catch {
    return null;
  }
})();

function notify(type, detail = {}) {
  if (parentOrigin) window.parent.postMessage({ source: 'charmd-provenance', type, ...detail }, parentOrigin);
}

function notifyStatus() {
  const d = state.data;
  const detail = {
    status: d.status || 'complete',
    title: d.title || null,
    documents: (d.documents || []).length,
    pages: state.order.length,
    facts: (d.facts || []).length,
    progress: d.progress?.label || null
  };
  const key = JSON.stringify(detail);
  if (key === state.lastStatus) return;
  const wasRunning = state.lastStatus && JSON.parse(state.lastStatus).status === 'running';
  state.lastStatus = key;
  notify('status', detail);
  if (detail.status === 'complete' && (wasRunning || !state.completeSent)) {
    state.completeSent = true;
    notify('complete', { ...detail, tables: (d.tables || []).map(t => ({ name: t.name, title: t.title || t.name, rows: (t.rows || []).length })) });
  }
}

function showError(message) {
  const e = $('error');
  e.textContent = message;
  e.hidden = false;
}

// ---- data ----------------------------------------------------------------

async function load(url) {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok && res.status !== 202) throw new Error(`could not load the view (${res.status})`);
  return res.json();
}

function docIndex(id) {
  return state.data.documents.findIndex(d => d.id === id);
}

function factsOn(doc, page) {
  const id = state.data.documents[doc]?.id;
  return (state.data.facts || []).filter(f => f.document === id && f.page === page);
}

function isRevealed(doc, page) {
  const i = state.order.findIndex(p => p.doc === doc && p.page === page);
  return i >= 0 && i < state.revealed;
}

// ---- quote search ----------------------------------------------------------

// Find a quote in page text, ignoring case, whitespace and punctuation runs.
// Returns [start, end) in the original text, or null.
function findQuote(text, quote) {
  const keep = /[\p{L}\p{N}]/u;
  const map = [];
  let norm = '';
  for (let i = 0; i < text.length; i++) {
    if (keep.test(text[i])) { norm += text[i].toLowerCase(); map.push(i); }
  }
  let q = '';
  for (const ch of quote) if (keep.test(ch)) q += ch.toLowerCase();
  if (q.length < 3) return null;
  const at = norm.indexOf(q);
  if (at < 0) return null;
  return [map[at], map[at + q.length - 1] + 1];
}

function highlightedText(text, quotes) {
  // quotes: [{ key, quote, active }]
  const ranges = [];
  for (const q of quotes) {
    const r = findQuote(text, q.quote);
    if (r) ranges.push({ start: r[0], end: r[1], key: q.key, active: q.active });
  }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  let pos = 0;
  for (const r of ranges) {
    if (r.start < pos) continue;   // overlapping quotes: the first wins
    out.push(text.slice(pos, r.start));
    out.push(el('mark', {
      class: r.active ? 'active' : null,
      'data-key': r.key,
      onclick: () => { state.activeFact = r.key; state.activeQuote = null; renderPage(); }
    }, text.slice(r.start, r.end)));
    pos = r.end;
  }
  out.push(text.slice(pos));
  return out;
}

// ---- pdf.js ----------------------------------------------------------------

let pdfjs = null;
async function pdfLib() {
  if (!pdfjs) {
    pdfjs = await import('./pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('./pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  }
  return pdfjs;
}

function pdfFor(doc) {
  const url = sameOriginUrl(state.data.documents[doc]?.pdf_url, state.dataUrl);
  if (!url) return null;
  if (!state.pdfs.has(doc)) {
    state.pdfs.set(doc, pdfLib().then(lib => lib.getDocument({ url, withCredentials: true }).promise));
  }
  return state.pdfs.get(doc);
}

async function renderImage(doc, page) {
  const pane = $('image-pane');
  const note = $('image-note');
  const width = Math.max(200, pane.clientWidth - 24);
  const key = `${doc}:${page}:${width}`;
  if (state.rendered === key) return;     // e.g. only the highlighted fact changed
  const seq = ++state.renderSeq;
  const pdf = pdfFor(doc);
  if (!pdf) {
    pane.classList.add('none');
    note.textContent = 'No page image for this document.';
    state.rendered = key;
    return;
  }
  pane.classList.remove('none');
  note.textContent = '';
  if (state.renderTask) state.renderTask.cancel();
  try {
    const p = await (await pdf).getPage(page);
    if (seq !== state.renderSeq) return;
    const base = p.getViewport({ scale: 1 });
    const scale = width / base.width;
    const ratio = window.devicePixelRatio || 1;
    const viewport = p.getViewport({ scale: scale * ratio });
    // Render off screen and swap in when done, so the previous page stays
    // visible meanwhile (pages change every few seconds while following a job).
    const off = document.createElement('canvas');
    off.width = Math.floor(viewport.width);
    off.height = Math.floor(viewport.height);
    state.renderTask = p.render({ canvas: off, canvasContext: off.getContext('2d'), viewport });
    await state.renderTask.promise;
    if (seq !== state.renderSeq) return;
    const canvas = $('canvas');
    canvas.width = off.width;
    canvas.height = off.height;
    canvas.style.width = `${Math.floor(viewport.width / ratio)}px`;
    canvas.getContext('2d').drawImage(off, 0, 0);
    state.rendered = key;
    renderOverlay(doc, page);
  } catch (err) {
    if (err?.name === 'RenderingCancelledException') return;
    if (seq === state.renderSeq) note.textContent = `Could not render this page (${err.message}).`;
  }
}

// ---- highlights on the page image -----------------------------------------

// Quotes to box on this page: [{ quote, active }].
function quotesToBox(doc, page) {
  if (state.highlight === 'off' || !isRevealed(doc, page)) return [];
  const out = [];
  for (const f of factsOn(doc, page)) {
    const active = f.id === state.activeFact;
    if (state.highlight === 'auto' || active) for (const q of f.quotes || []) out.push({ quote: q, active });
  }
  const aq = state.activeQuote;
  if (aq && aq.doc === doc && aq.page === page) out.push({ quote: aq.quote, active: true });
  return out;
}

async function fetchBoxes(doc, page, quotes) {
  const d = state.data.documents[doc];
  const url = sameOriginUrl(d?.locate_url, state.dataUrl);
  if (!url) return;
  const key = `${doc}#${page}`;
  const known = state.boxes.get(key) || new Map();
  state.boxes.set(key, known);
  const missing = [...new Set(quotes)].filter(q => !known.has(q) && !state.locating.has(`${key}#${q}`));
  if (!missing.length) return;
  missing.forEach(q => state.locating.add(`${key}#${q}`));
  try {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ document: d.id, page, quotes: missing })
    });
    const json = res.ok ? await res.json() : { boxes: [] };
    for (const q of missing) known.set(q, (json.boxes || []).find(b => b.quote === q.trim())?.box || null);
  } catch {
    for (const q of missing) known.set(q, null);
  } finally {
    missing.forEach(q => state.locating.delete(`${key}#${q}`));
  }
  const at = state.order[state.cursor];
  if (at && at.doc === doc && at.page === page) renderOverlay(doc, page);
}

function renderOverlay(doc, page) {
  const overlay = $('overlay');
  overlay.replaceChildren();
  // Boxes belong to the page on the canvas; wait until it is there.
  if (!String(state.rendered).startsWith(`${doc}:${page}:`)) return;
  const wanted = quotesToBox(doc, page);
  if (!wanted.length || !state.data.documents[doc]?.pdf_url) return;
  const known = state.boxes.get(`${doc}#${page}`) || new Map();
  for (const { quote, active } of wanted) {
    const box = known.get(quote);
    if (!box) continue;
    const [x0, y0, x1, y1] = box;
    overlay.append(el('div', {
      class: `hl${active ? ' active' : ''}`,
      style: `left:${x0 * 100}%;top:${y0 * 100}%;width:${(x1 - x0) * 100}%;height:${(y1 - y0) * 100}%`
    }));
  }
  const active = overlay.querySelector('.hl.active');
  if (active) active.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const missing = wanted.map(w => w.quote).filter(q => !known.has(q));
  if (missing.length) fetchBoxes(doc, page, missing);
}

// ---- rendering -------------------------------------------------------------

function renderStatus() {
  const d = state.data;
  const pages = state.order.length;
  const facts = (d.facts || []).length;
  let text = `${d.documents.length} document${d.documents.length === 1 ? '' : 's'} · ${pages} pages · ${facts} facts`;
  if (Number.isFinite(state.revealed) && state.revealed < pages) text = `Reading page ${state.revealed + 1} of ${pages}`;
  if (d.status === 'running') text = `${d.progress?.label || 'Working…'} · ${facts} facts so far`;
  if (d.status === 'error') text = `Failed: ${d.error || 'unknown error'}`;
  $('status').textContent = text;
}

function renderTray() {
  const tray = $('tray');
  tray.replaceChildren();
  state.data.documents.forEach((d, doc) => {
    tray.append(el('h3', {}, d.filename || d.id));
    const grid = el('div', { class: 'grid' });
    for (const p of d.pages) {
      const i = state.order.findIndex(o => o.doc === doc && o.page === p.number);
      const current = i === state.cursor;
      const classes = ['tile'];
      if (current) classes.push('current');
      if (!isRevealed(doc, p.number)) classes.push('unread');
      else if (factsOn(doc, p.number).length) classes.push('has-facts');
      grid.append(el('button', {
        type: 'button',
        class: classes.join(' '),
        'aria-current': current ? 'page' : null,
        'aria-label': `Page ${p.number}`,
        onclick: () => goTo(i, { stopReplay: true })
      }, p.number));
    }
    tray.append(grid);
  });
}

function renderPage() {
  const at = state.order[state.cursor];
  if (!at) return;
  const d = state.data.documents[at.doc];
  const page = d.pages.find(p => p.number === at.page);
  const read = isRevealed(at.doc, at.page);
  $('page-label').textContent = `${d.filename || d.id} · page ${at.page} of ${d.pages.length}`;
  if (state.notifiedPage !== `${d.id}#${at.page}`) {
    state.notifiedPage = `${d.id}#${at.page}`;
    notify('page', { document: d.id, filename: d.filename || null, page: at.page });
  }

  const facts = read ? factsOn(at.doc, at.page) : [];
  const quotes = facts.flatMap(f => (f.quotes || []).map(q => ({ key: f.id, quote: q, active: f.id === state.activeFact })));
  if (state.activeQuote && state.activeQuote.doc === at.doc && state.activeQuote.page === at.page) {
    quotes.unshift({ key: '__table', quote: state.activeQuote.quote, active: true });
  }
  const text = $('text-pane');
  text.classList.toggle('unread', !read);
  text.replaceChildren(...(read ? highlightedText(page?.text || '', quotes) : ['Not read yet.']));
  const active = text.querySelector('mark.active');
  if (active) active.scrollIntoView({ block: 'center', behavior: 'smooth' });

  const list = $('facts');
  list.replaceChildren();
  if (!facts.length) {
    list.append(el('li', { class: 'empty' }, read ? 'Nothing extracted from this page.' : 'Not read yet.'));
  }
  for (const f of facts) {
    list.append(el('li', {}, el('button', {
      type: 'button',
      class: `fact${f.id === state.activeFact ? ' active' : ''}`,
      onclick: () => {
        state.activeFact = f.id === state.activeFact ? null : f.id;
        state.activeQuote = null;
        renderPage();
        if (state.activeFact) notify('fact', { id: f.id, label: f.label, detail: f.detail || null, document: d.id, page: at.page, quotes: f.quotes || [] });
      }
    },
    el('span', { class: 'label' }, f.label),
    f.detail ? el('span', { class: 'detail' }, f.detail) : null,
    ...(f.quotes || []).map(q => el('span', { class: 'quote' }, `“${q}”`)))));
  }

  renderImage(at.doc, at.page);
  renderOverlay(at.doc, at.page);
  renderTray();
  renderStatus();
}

function cellRevealed(sources) {
  return !Number.isFinite(state.revealed) || sources.some(s => isRevealed(docIndex(s.document), s.page));
}

function renderTables() {
  const view = $('tables-view');
  view.replaceChildren();
  const tables = state.data.tables || [];
  if (!tables.length) {
    view.append(el('p', { class: 'note' },
      state.data.status === 'running' ? 'The tables appear when every page has been read.' : 'No tables.'));
  }
  for (const t of tables) {
    const head = el('tr', {}, t.columns.map(c => el('th', { scope: 'col' }, c)));
    const body = t.rows.map(r => el('tr', {}, t.columns.map(c => {
      const sources = (r.sources?.[c] || []).filter(s => docIndex(s.document) >= 0);
      const value = r.cells[c];
      const shown = value === null || value === undefined ? '' : String(value);
      if (!sources.length) return el('td', {}, shown);
      if (!cellRevealed(sources)) return el('td', { class: 'pending' }, '…');
      const first = sources[0];
      return el('td', {
        class: 'sourced',
        title: `${sources.length} source${sources.length === 1 ? '' : 's'}; first: page ${first.page} — “${first.quote}”`,
        tabindex: 0,
        onclick: () => openSource(first),
        onkeydown: e => { if (e.key === 'Enter') openSource(first); }
      }, shown);
    })));
    view.append(el('section', {},
      el('h2', {}, t.title || t.name, ` (${t.rows.length})`),
      el('div', { class: 'scroll' }, el('table', {}, el('thead', {}, head), el('tbody', {}, body))),
      t.note ? el('p', { class: 'note' }, t.note) : null));
  }
}

function renderWarnings() {
  const w = state.data.warnings || [];
  const list = $('warnings');
  list.hidden = !w.length;
  list.replaceChildren(...w.map(x => el('li', {}, x.message || String(x))));
}

function setTab(tab) {
  state.tab = tab;
  $('tab-pages').setAttribute('aria-selected', String(tab === 'pages'));
  $('tab-tables').setAttribute('aria-selected', String(tab === 'tables'));
  $('pages-view').hidden = tab !== 'pages';
  $('tables-view').hidden = tab !== 'tables';
  if (tab === 'tables') renderTables(); else renderPage();
}

function openSource(src) {
  const doc = docIndex(src.document);
  const i = state.order.findIndex(o => o.doc === doc && o.page === src.page);
  if (i < 0) return;
  state.activeFact = null;
  state.activeQuote = { doc, page: src.page, quote: src.quote };
  notify('source', { document: src.document, page: src.page, quote: src.quote });
  stopReplay();
  state.cursor = i;
  setTab('pages');
}

function goTo(i, { stopReplay: stop = false } = {}) {
  if (i < 0 || i >= state.order.length) return;
  if (stop) { stopReplay(); setFollow(false); }
  state.cursor = i;
  state.activeFact = null;
  state.activeQuote = null;
  renderPage();
}

// ---- replay ----------------------------------------------------------------

function setFollow(on) {
  state.follow = on && state.data?.status === 'running';
  $('follow').hidden = state.data?.status !== 'running' || state.follow;
}

function pageOrder(d) {
  return d.documents.flatMap((doc, i) => doc.pages.map(p => ({ doc: i, page: p.number })));
}

// New data from a poll: keep the page on screen (or follow the newest), redraw.
function apply(d) {
  const at = state.order[state.cursor];
  const atKey = at ? `${state.data.documents[at.doc]?.id}#${at.page}` : null;
  d.documents = d.documents || [];
  state.data = d;
  state.order = pageOrder(d);
  notifyStatus();
  if (state.follow) {
    state.cursor = state.order.length - 1;
  } else if (atKey) {
    const i = state.order.findIndex(o => `${d.documents[o.doc].id}#${o.page}` === atKey);
    state.cursor = Math.max(0, i);
  }
  if (d.status !== 'running') setFollow(false); else $('follow').hidden = state.follow;
  renderWarnings();
  if (state.tab === 'tables') { renderTables(); renderStatus(); } else renderPage();
}

function stopReplay() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.playing = false;
  $('replay').textContent = state.revealed < state.order.length ? 'Play' : 'Replay';
}

function startReplay(ms) {
  if (state.revealed >= state.order.length) state.revealed = 0;
  state.playing = true;
  $('replay').hidden = false;
  $('replay').textContent = 'Pause';
  const step = () => {
    state.revealed += 1;
    state.cursor = Math.min(state.revealed, state.order.length) - 1;
    if (state.tab === 'pages') renderPage(); else { renderTables(); renderStatus(); }
    if (state.revealed >= state.order.length) stopReplay();
  };
  if (state.revealed === 0) step();
  state.timer = setInterval(step, ms);
}

// ---- start -----------------------------------------------------------------

async function main() {
  const url = sameOriginUrl(params.get('data'));
  state.dataUrl = url;
  if (!url) {
    showError('Missing or invalid ?data= (it must be a URL on this server).');
    return;
  }
  const pollMs = Math.max(1000, Number(params.get('poll_ms')) || 3000);
  const replayMs = Number(params.get('replay_ms')) || 0;

  try {
    state.data = await load(url);
    // Nothing to show until the first page is transcribed.
    while (state.data.status === 'running' && !(state.data.documents || []).some(d => d.pages?.length)) {
      $('title').textContent = state.data.title || 'Documents';
      $('status').textContent = '';
      $('waiting').hidden = false;
      $('waiting').textContent = state.data.progress?.label || 'Working…';
      notifyStatus();
      await new Promise(r => setTimeout(r, pollMs));
      state.data = await load(url);
    }
  } catch (err) {
    showError(err.message);
    return;
  }
  $('waiting').hidden = true;
  const d = state.data;
  $('title').textContent = d.title || 'Documents';
  $('subtitle').textContent = d.subtitle || '';
  if (d.status === 'error') { renderStatus(); showError(d.error || 'The job failed.'); return; }
  d.documents = d.documents || [];
  state.order = pageOrder(d);
  notifyStatus();
  if (!state.order.length) { showError('No pages to show.'); return; }

  const startDoc = Number(params.get('doc')) || 0;
  const startPage = Number(params.get('page')) || null;
  const first = state.order.findIndex(o => o.doc === startDoc && (startPage === null || o.page === startPage));
  state.cursor = Math.max(0, first);
  const running = d.status === 'running';

  $('tab-pages').addEventListener('click', () => setTab('pages'));
  $('tab-tables').addEventListener('click', () => setTab('tables'));
  $('prev').addEventListener('click', () => goTo(state.cursor - 1, { stopReplay: true }));
  $('next').addEventListener('click', () => goTo(state.cursor + 1, { stopReplay: true }));
  $('replay').addEventListener('click', () => (state.playing ? stopReplay() : startReplay(replayMs || 800)));
  document.addEventListener('keydown', e => {
    if (state.tab !== 'pages' || e.target.closest('input, textarea')) return;
    if (e.key === 'ArrowLeft') goTo(state.cursor - 1, { stopReplay: true });
    if (e.key === 'ArrowRight') goTo(state.cursor + 1, { stopReplay: true });
  });
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (state.tab === 'pages') renderPage(); }, 200);
  });

  $('follow').addEventListener('click', () => { setFollow(true); apply(state.data); });
  renderWarnings();
  $('pages-view').hidden = false;
  if (running) {
    // Pages and facts arrive while the job runs.
    state.revealed = Infinity;
    setFollow(startPage === null);
    if (state.follow) state.cursor = state.order.length - 1;
    renderPage();
    while (state.data.status === 'running') {
      await new Promise(r => setTimeout(r, pollMs));
      try {
        apply(await load(url));
      } catch (err) {
        showError(err.message);
        return;
      }
    }
    if (state.data.status === 'error') showError(state.data.error || 'The job failed.');
  } else if (replayMs > 0) {
    state.revealed = 0;
    startReplay(replayMs);
  } else {
    state.revealed = Infinity;
    renderPage();
  }
}

main();
