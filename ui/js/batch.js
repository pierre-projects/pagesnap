// Capturing a list of pages: the list editor, then a grid with one card per page that follows
// the whole list over one SSE stream (/api/batches/:id/events).

import { $, el, btn, icon } from './dom.js';
import { api, json, fileUrl, zipUrl } from './api.js';
import { fmtMs, fmtSize, fmtAbout, fmtElapsed, prettyUrl, viewportLabel, partsText } from './format.js';
import { toast } from './toast.js';
import { showTab } from './tabs.js';
import { emit } from './events.js';
import * as store from './store.js';
import { buildRequest, saveForm, closeOptions } from './options.js';
import { urlInput, checkUrl, withScheme } from './url.js';
import { showBatchView, pill } from './view.js';
import { showCapture } from './result.js';

// Same limit as MAX_LIST in lib/snap/batch.js.
const MAX_LIST = 200;
const STEP_ACTIVE = { load: 'Loading', cookies: 'Cleaning up', scroll: 'Scrolling', capture: 'Saving' };
// Time per page for estimates until real times are known.
const DEFAULT_MS = 8000;
let PARALLEL = 3; // pages the server captures at the same time (/api/config)
let pastMs = null; // the usual time of the recent captures in History

// The server's number of captures at the same time (from /api/config).
export function setParallel(n) { if (Number.isInteger(n) && n > 0) PARALLEL = n; }

// The usual (median) time of the last 30 captures, for the estimate before a list starts.
async function loadPastTimes() {
  try {
    const ms = (await api('/api/captures')).map((c) => c.ms).filter((n) => n > 0).slice(0, 30).sort((a, b) => a - b);
    pastMs = ms.length ? ms[Math.floor(ms.length / 2)] : null;
  } catch { /* keep the default */ }
  if (!$('#bcompose').hidden) checkList();
}

// How long one page of `b` takes: the pages of the list that ended, else the recent captures.
function perPage(b) {
  const ended = b?.items.filter((x) => x.ms) ?? [];
  if (ended.length) return ended.reduce((s, x) => s + x.ms, 0) / ended.length;
  return pastMs ?? DEFAULT_MS;
}

// When each waiting page of `b` should start, and when the list should end, in ms from now.
// Fills PARALLEL slots in order; a running page frees its slot after about one page's time.
function schedule(b) {
  const avg = perPage(b);
  const now = Date.now();
  const slots = b.items.filter((x) => x.state === 'running')
    .map((x) => Math.max(avg - (now - (x.startedAt ?? now)), avg * 0.15));
  while (slots.length < PARALLEL) slots.push(0);
  const starts = new Map();
  for (const it of b.items) {
    if (it.state !== 'queued' || it.cancelling) continue;
    const i = slots.indexOf(Math.min(...slots));
    starts.set(it.id, slots[i]);
    slots[i] += avg;
  }
  return { starts, left: Math.max(...slots) };
}

// The layout of the results (grid | rows) and which pages show (all, or one group).
let view = store.load().listView === 'rows' ? 'rows' : 'grid';
let filter = 'all';
const GROUPS = [['all', 'All'], ['queued', 'Waiting'], ['running', 'Running'], ['done', 'Saved'], ['failed', 'Not saved']];
const groupOf = (it) => (it.state === 'error' || it.state === 'cancelled' ? 'failed' : it.state);
const shows = (it) => filter === 'all' || groupOf(it) === filter;

const area = $('#blist');
const goBtn = $('#bgo');

// The last list, running or ended: { id, req, started, items, ended, es, timer }. It stays until a
// new list starts or "New list" is clicked, so its results can always be shown again.
let batch = null;
let fromList = false; // the capture on screen was opened from the list's grid
// The pages of the list that "Edit list" came from, by URL: the editor marks each line with how
// that page went. Null when the editor is not editing a list that ran.
let marks = null;
const markKey = (u) => withScheme(u.trim());
const cards = new Map(); // job id -> card element

export const batchRunning = () => !!batch && !batch.ended;

// The URLs in `text` with their line numbers, one on each line. Blank lines and lines that start
// with # are skipped, and a repeated URL counts once. Same rule as parseUrlList() in lib/snap/batch.js.
export function parseList(text) {
  const seen = new Set();
  const out = [];
  String(text).split(/\r?\n/).forEach((raw, i) => {
    const url = raw.trim();
    if (!url || url.startsWith('#') || seen.has(url)) return;
    seen.add(url);
    out.push({ line: i + 1, url });
  });
  return out;
}

// ---------- the list editor ----------

// Show the list editor, with `text` in it if given. A list that is still running is shown instead.
// `from` is the list that "Edit list" came from: its pages are marked in the editor.
export function openList(text, { from } = {}) {
  showTab('result');
  if (batchRunning()) { showBatch(); return; }
  setBack(false);
  showBatchView();
  $('#bcompose').hidden = false;
  $('#brun').hidden = true;
  if (from) marks = new Map(from.items.map((it) => [markKey(it.url), it]));
  if (text !== undefined) area.value = text;
  else if (!area.value) area.value = store.load().list ?? '';
  area.scrollTop = 0;
  // The site to search: the last one searched, else the URL field.
  const site = $('#fsite');
  if (!site.value) site.value = store.load().findSite ?? urlInput.value.trim();
  if (!finding) findStatus(DEFAULT_FIND_HINT);
  checkList();
  loadPastTimes();
  area.focus();
}

// Count the URLs, and list the lines that are not URLs. Returns the URLs to capture, or null
// when the list cannot be captured as it is.
function checkList() {
  const entries = parseList(area.value);
  const bad = entries.map((e) => ({ ...e, problem: checkUrl(e.url) })).filter((e) => e.problem);
  const n = entries.length;
  const ok = n > 0 && !bad.length && n <= MAX_LIST;
  goBtn.disabled = !ok;
  goBtn.textContent = n > 1 ? `Capture ${n} pages` : n === 1 ? 'Capture 1 page' : 'Capture pages';
  // The estimate: the pages run PARALLEL at a time, each about as long as recent captures.
  const each = pastMs ?? DEFAULT_MS;
  const est = ok ? ` · takes ${fmtAbout(Math.ceil(n / PARALLEL) * each)}` : '';
  $('#bcount').textContent = !n ? 'Type or paste one URL on each line.'
    : n > MAX_LIST ? `${n} URLs. The most is ${MAX_LIST}: split the list.`
    : `${n} ${n === 1 ? 'URL' : 'URLs'}${bad.length ? `, ${bad.length} not valid` : ''}${est}`;
  $('#bcount').title = ok ? `${PARALLEL} pages at a time, about ${fmtMs(Math.round(each / 100) * 100)} each${pastMs ? ': the usual time of your recent captures' : ''}. Big or slow pages take longer.` : '';

  renderGutter();
  renderLastList();

  const box = $('#bproblems');
  box.replaceChildren();
  if (bad.length) {
    const shown = bad.slice(0, 5);
    box.append(el('div', { class: 'notice warn', role: 'status' }, icon('alert'),
      el('div', { class: 'body' },
        el('b', {}, bad.length === 1 ? 'One line is not a URL. Fix it or remove it.' : `${bad.length} lines are not URLs. Fix them or remove them.`),
        el('ul', { class: 'badlines' }, ...shown.map((e) => el('li', {},
          el('button', { type: 'button', class: 'linkish', onclick: () => selectLine(e.line) }, `Line ${e.line}`),
          ` ${e.url.length > 60 ? `${e.url.slice(0, 60)}…` : e.url}: ${e.problem}`)),
          bad.length > shown.length ? el('li', {}, `and ${bad.length - shown.length} more`) : null))));
  }
  return ok ? entries.map((e) => e.url) : null;
}

const MARK = {
  done: ['✓', 'Saved'], error: ['✕', 'Failed'], cancelled: ['–', 'Cancelled'],
  queued: ['', ''], running: ['', ''],
};

// A mark next to each line of the editor that is a page of the last list: ✓ saved, ✕ failed,
// – cancelled. The gutter scrolls with the text; the text does not wrap, so lines stay level.
function renderGutter() {
  const g = $('#bgutter');
  g.hidden = !marks;
  if (!marks) return;
  g.replaceChildren(...area.value.split('\n').map((line) => {
    const it = line.trim() && !line.trim().startsWith('#') ? marks.get(markKey(line)) : null;
    const [mark, label] = MARK[it?.state] ?? ['', ''];
    return el('div', { class: `mk ${it?.state ?? ''}`, title: label ? `${label}${it.state === 'error' && it.error ? `: ${it.error}` : ''}` : null }, mark || ' ');
  }));
  g.scrollTop = area.scrollTop;
}

// The banner over the editor while a list exists: how its pages went, the way back to its
// results, and a quick way to keep only the pages that were not saved.
function renderLastList() {
  const box = $('#lastlist');
  box.hidden = !batch;
  if (!batch) return;
  const lines = parseList(area.value).map((e) => marks?.get(markKey(e.url)));
  const saved = lines.filter((it) => it?.state === 'done').length;
  const failed = lines.filter((it) => it?.state === 'error').length;
  const cancelled = lines.filter((it) => it?.state === 'cancelled').length;
  const added = lines.filter((it) => !it).length;
  const parts = [
    saved ? `✓ ${saved} saved` : null,
    failed ? `✕ ${failed} failed` : null,
    cancelled ? `– ${cancelled} cancelled` : null,
    marks && added ? `${added} new` : null,
  ].filter(Boolean);
  box.replaceChildren(
    el('div', { class: 'body' },
      el('b', {}, marks ? 'Editing your last list' : 'Your last list'),
      el('span', {}, marks ? (parts.length ? parts.join(' · ') : 'None of these pages were in it.') : `${batch.items.length} pages. Its results are still here.`)),
    el('div', { class: 'acts' },
      marks && saved ? btn(`Remove the ${saved} saved`, 'x', { class: 'btn ghost', title: 'Take the pages that were saved out of the list, to capture only the rest', onclick: removeSaved }) : null,
      btn('Back to the results', 'left', { class: 'btn', onclick: showBatch })));
}

function removeSaved() {
  const before = parseList(area.value).length;
  area.value = area.value.split('\n').filter((line) => marks.get(markKey(line))?.state !== 'done').join('\n').replace(/\n{3,}/g, '\n\n').trim();
  store.patch({ list: area.value });
  checkList();
  const n = before - parseList(area.value).length;
  toast(`${n} saved ${n === 1 ? 'page was' : 'pages were'} taken out of the list.`);
}

// Select line `n` (1-based) of the list, so it can be fixed.
function selectLine(n) {
  const lines = area.value.split('\n');
  const start = lines.slice(0, n - 1).reduce((s, l) => s + l.length + 1, 0);
  area.focus();
  area.setSelectionRange(start, start + lines[n - 1].length);
}

// A text or CSV file: each line's first cell that looks like a URL. Added under what is there.
async function loadFile(file) {
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) { toast('The file is too large. Use a list of 2 MB or less.'); return; }
  const text = await file.text();
  const urls = text.split(/\r?\n/).map((line) => {
    const cells = line.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, ''));
    return cells.find((c) => /^(https?:|file:)/i.test(c) || /^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(c)) ?? '';
  }).filter(Boolean);
  if (!urls.length) { toast('No URLs were found in the file.'); return; }
  area.value = [area.value.trimEnd(), ...urls].filter(Boolean).join('\n');
  checkList();
  store.patch({ list: area.value });
  toast(`${urls.length} ${urls.length === 1 ? 'URL was' : 'URLs were'} added from ${file.name}.`);
}

// ---------- finding the pages of a site ----------

const DEFAULT_FIND_HINT = $('#fstatus').textContent;
let finding = null; // AbortController of the search in progress

function findStatus(text, kind = '') {
  const s = $('#fstatus');
  s.className = `hint ${kind}`;
  s.replaceChildren(...(kind === 'busy' ? [el('span', { class: 'spinner', 'aria-hidden': 'true' })] : []), text);
}

function setFinding(on) {
  $('#fgo').textContent = on ? 'Stop' : 'Find pages';
  $('#fsite').disabled = on;
  $('#fmode').disabled = on;
}

// Ask the server for the pages of the site in the field, and add them to the list.
async function findSite(e) {
  e?.preventDefault();
  if (finding) { finding.abort(); return; }
  const site = $('#fsite').value.trim();
  const problem = site ? checkUrl(site) : 'Type the address of a site.';
  if (problem) { findStatus(problem, 'error'); $('#fsite').focus(); return; }
  store.patch({ findSite: site, findMode: $('#fmode').value });
  const controller = finding = new AbortController();
  setFinding(true);
  findStatus('Looking for the sitemap…', 'busy');
  let result = null;
  let error = null;
  try {
    const res = await fetch('/api/find', { ...json({ site, mode: $('#fmode').value }), signal: controller.signal });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `The server sent HTTP ${res.status}.`);
    // One JSON object on each line, as the server finds pages.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines.filter(Boolean)) {
        const m = JSON.parse(l);
        if (m.type === 'progress') findStatus(`Found ${m.found} ${m.found === 1 ? 'page' : 'pages'}…`, 'busy');
        else if (m.type === 'log' && /^(Reading|The site has no|The sitemap has no|The start page)/.test(m.message)) findStatus(m.message, 'busy');
        else if (m.type === 'done') result = m;
        else if (m.type === 'error') error = m.message;
      }
    }
    if (!result && !error) error = 'The search stopped before it ended.';
  } catch (err) {
    error = controller.signal.aborted ? null : err.name === 'TypeError' ? 'The pagesnap server did not reply. Make sure that it is running.' : err.message;
    if (controller.signal.aborted) findStatus('The search was stopped. Nothing was added.');
  } finally {
    finding = null;
    setFinding(false);
  }
  if (error) { findStatus(error, 'error'); return; }
  if (result) addFound(result, site);
}

// Add the pages found to the list, after what is there, and say what happened.
function addFound({ urls, source, truncated }, site) {
  const before = parseList(area.value);
  const have = new Set(before.map((x) => x.url));
  const fresh = urls.filter((u) => !have.has(u));
  area.value = [area.value.trimEnd(), ...fresh].filter(Boolean).join('\n');
  store.patch({ list: area.value });
  checkList();
  const from = source === 'sitemap' ? 'from the sitemap' : 'by following links';
  const added = fresh.length === urls.length ? `Added ${fresh.length} ${fresh.length === 1 ? 'page' : 'pages'} ${from}.`
    : !fresh.length ? `Found ${urls.length} ${urls.length === 1 ? 'page' : 'pages'} ${from}. All of them are already in the list.`
    : `Found ${urls.length} pages ${from}. Added the ${fresh.length} that were not in the list yet.`;
  let hasPath = false;
  try { hasPath = new URL(withScheme(site)).pathname.replace(/\/+$/, '') !== ''; } catch {}
  const more = hasPath ? ' There are more: use a longer path to pick a smaller part.'
    : ' The site has more: add a path to the address to pick a part, for example /blog.';
  findStatus(`${added}${truncated ? more : ''}`, truncated ? 'warn' : 'ok');
}

// ---------- running a list ----------

async function start(urls) {
  if (batchRunning()) return;
  // The Capture button is disabled while a single capture runs (capture.js).
  if ($('#go').disabled) { toast('Wait for the current capture to finish.'); return; }
  let req;
  try { req = buildRequest(urls[0]); } catch (err) { toast(err.message); return; }
  delete req.url;
  saveForm();
  store.patch({ list: area.value });
  closeOptions();
  goBtn.disabled = true;
  let res;
  try {
    res = await api('/api/batch', json({ ...req, urls }));
  } catch (err) {
    toast(err.message);
    checkList();
    return;
  }
  const b = batch = {
    id: res.id, req, started: Date.now(), ended: false,
    items: res.jobs.map((j, i) => ({ id: j.id, url: j.url, n: i + 1, state: 'queued' })),
  };
  filter = 'all';
  marks = null;
  // Kept so the list's results come back after a reload.
  store.patch({ lastList: { id: b.id, req, started: b.started, items: b.items.map(({ id, url, n }) => ({ id, url, n })) } });
  showRun();
  b.timer = setInterval(() => renderHead(b), 1000);
  follow(b);
}

function follow(b) {
  const es = b.es = new EventSource(`/api/batches/${b.id}/events`);
  es.addEventListener('job', (ev) => {
    const { id, type, data } = JSON.parse(ev.data);
    const it = b.items.find((x) => x.id === id);
    if (it) update(b, it, type, data);
  });
  es.addEventListener('end', () => finish(b));
  es.addEventListener('error', () => {
    if (b.ended) return;
    finish(b);
    $('#bnotices').append(el('div', { class: 'notice error', role: 'alert' }, icon('alert'),
      el('div', { class: 'body' }, el('b', {}, 'The connection to the pagesnap server stopped.'),
        'Make sure that the server is running. Captures that were saved are in History.')));
  });
}

let changedTimer;
function update(b, it, type, data) {
  if (type === 'queued') { it.ahead = data.ahead; if (it.state !== 'queued') return; }
  else if (type === 'step') { it.state = 'running'; it.step = data; it.progress = null; it.startedAt ??= Date.now(); }
  else if (type === 'progress') {
    it.progress = Math.min(1, data.y / data.height);
    if (b === batch) setProgress(it);
    return;
  } else if (type === 'done') {
    it.state = 'done';
    it.entry = data;
    it.ms = data.ms || (it.startedAt && Date.now() - it.startedAt);
    // History and its badge, at most once a second while pages finish.
    clearTimeout(changedTimer);
    changedTimer = setTimeout(() => emit('captures-changed'), 1000);
  } else if (type === 'error') {
    it.state = data.cancelled ? 'cancelled' : 'error';
    it.error = data.cancelled ? 'Cancelled' : data.message;
    it.cancelling = false;
    // A failed page counts toward the time per page; a cancelled one says nothing about it.
    if (!data.cancelled && it.startedAt) it.ms = Date.now() - it.startedAt;
  }
  if (b !== batch) return;
  renderCard(it);
  renderHead(b);
}

function finish(b) {
  if (b.ended) return;
  b.ended = true;
  b.endedAt ??= Date.now();
  const saved = store.load().lastList;
  if (saved?.id === b.id) store.patch({ lastList: { ...saved, endedAt: b.endedAt } });
  b.es?.close();
  clearInterval(b.timer);
  // A page whose end the stream missed is no longer running.
  for (const it of b.items) if (it.state === 'queued' || it.state === 'running') { it.state = 'cancelled'; it.error = 'No result was received.'; renderCard(it); }
  renderHead(b);
  emit('captures-changed');
  const failed = b.items.filter((x) => x.state !== 'done').length;
  if (document.hidden) document.title = failed ? `✕ ${failed} failed · pagesnap` : '✓ List ready · pagesnap';
  else document.title = 'pagesnap';
}

async function cancelAll(b) {
  try { await api(`/api/batches/${b.id}/cancel`, { method: 'POST' }); }
  catch (err) { toast(err.message); }
}

// Cancel one page of the list. The others go on; a waiting page never starts.
async function cancelOne(it) {
  it.cancelling = true;
  renderCard(it);
  let ok = false;
  try { ({ ok } = await api(`/api/jobs/${it.id}/cancel`, { method: 'POST' })); }
  catch (err) { toast(err.message); }
  // Not cancelled: the page ended meanwhile, and its own event redraws it.
  if (!ok && it.cancelling) { it.cancelling = false; renderCard(it); }
}

// Forget the last list and start an empty one. Its captures stay in History.
function newList() {
  batch = null;
  marks = null;
  area.value = '';
  store.patch({ lastList: null, list: '' });
  openList('');
}

// After a reload: bring back the last list. If the server still has it, its events replay and a
// running list goes on showing; if not, what was saved comes from History.
async function restoreList() {
  const saved = store.load().lastList;
  if (!saved?.id || !Array.isArray(saved.items)) return;
  const b = {
    id: saved.id, req: saved.req, started: saved.started, endedAt: saved.endedAt, ended: false,
    items: saved.items.map((x) => ({ ...x, state: 'queued' })),
  };
  let status = null;
  try { status = await api(`/api/batches/${b.id}`); } catch { /* not known any more */ }
  if (batch) return; // a new list started meanwhile
  batch = b;
  if (status) {
    b.timer = setInterval(() => renderHead(b), 1000);
    follow(b);
    // A list that still runs comes back on screen, unless the person is doing something else.
    if (!status.ended && !$('#empty').hidden) showBatch();
    return;
  }
  const caps = await api('/api/captures').catch(() => []);
  const byUrl = new Map(caps.filter((c) => c.batch === b.id).map((c) => [c.url, c]));
  for (const it of b.items) {
    const c = byUrl.get(it.url);
    if (c) Object.assign(it, { state: 'done', entry: c, ms: c.ms });
    else Object.assign(it, { state: 'cancelled', error: 'Not saved' });
  }
  b.ended = true;
  b.endedAt ??= Math.max(b.started, ...b.items.map((it) => it.entry?.createdAt ?? 0));
}

// ---------- the results ----------

// Show the list that runs or ran last (after "Back to the list").
export function showBatch() {
  if (!batch) { openList(); return; }
  showTab('result');
  setBack(false);
  showBatchView();
  showRun();
}

function showRun() {
  $('#bcompose').hidden = true;
  $('#brun').hidden = false;
  $('#bnotices').replaceChildren();
  renderAll();
}

// Draw every page again, in the layout that is set.
function renderAll() {
  cards.clear();
  const box = $('#bgrid');
  box.className = view === 'rows' ? 'brows' : 'grid batchgrid';
  box.replaceChildren();
  for (const b of $('#bview').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.v === view));
  batch.sched = schedule(batch).starts;
  batch.items.forEach(renderCard);
  delete $('#bfilters').dataset.key;
  renderHead(batch);
}

function setView(v) {
  view = v;
  store.patch({ listView: v });
  if (batch) renderAll();
}

function setFilter(f) {
  filter = f;
  for (const it of batch.items) { const c = cards.get(it.id); if (c) c.hidden = !shows(it); }
  delete $('#bfilters').dataset.key;
  renderHead(batch);
}

// The filter buttons with the count of each group: "All 120", "Waiting 80", "Saved 37", ...
function renderFilters(b) {
  const counts = { all: b.items.length };
  for (const it of b.items) counts[groupOf(it)] = (counts[groupOf(it)] ?? 0) + 1;
  const box = $('#bfilters');
  const key = `${filter}:${GROUPS.map(([g]) => counts[g] ?? 0).join(',')}`;
  $('#bnone').hidden = !b.items.length || (counts[filter] ?? 0) > 0;
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.replaceChildren(...GROUPS.filter(([g]) => g === 'all' || g === filter || counts[g]).map(([g, label]) =>
    el('button', { type: 'button', class: `chip ${g}`, 'aria-pressed': String(filter === g), onclick: () => setFilter(g) },
      label, el('span', { class: 'count' }, String(counts[g] ?? 0)))));
}

function renderHead(b) {
  const n = b.items.length;
  const count = (s) => b.items.filter((x) => x.state === s).length;
  const done = count('done');
  const failed = count('error');
  const cancelled = count('cancelled');
  const finished = done + failed + cancelled;
  $('#btitle').textContent = `List of ${n} ${n === 1 ? 'page' : 'pages'}`;
  const status = !b.ended ? pill('running', `Capturing · ${finished} of ${n} done`)
    : done === n ? pill('done', n === 1 ? 'Saved' : `All ${n} saved`)
    : !done ? pill('error', cancelled === n ? 'Cancelled' : 'Nothing saved')
    : pill('error', `${done} saved · ${n - done} not saved`);
  // While it runs: the time so far and an estimate of the time left, from the pages that ended.
  let left = null;
  if (!b.ended) {
    const s = schedule(b);
    b.sched = s.starts;
    left = s.left;
  }
  $('#bmeta').replaceChildren(status, ...[
    b.ended ? `Took ${fmtElapsed(b.endedAt - b.started)}` : `${fmtElapsed(Date.now() - b.started)} so far`,
    left !== null && finished < n ? `${fmtAbout(left)} left` : null,
    failed && !b.ended ? `${failed} failed` : null,
    viewportLabel(b.req),
    b.req.format.toUpperCase(),
  ].filter(Boolean).map((t) => el('span', {}, t)));
  $('#bbar').style.width = `${(finished / n) * 100}%`;
  $('#boverall').setAttribute('aria-valuenow', String(Math.round((finished / n) * 100)));
  $('#boverall').classList.toggle('ended', b.ended && done === n);
  if (!b.ended && !document.hidden) document.title = `Capturing ${finished}/${n}… · pagesnap`;
  renderFilters(b);
  // Waiting and running pages: their start estimate and time, without redrawing them.
  for (const it of b.items) if (it.state === 'queued' || it.state === 'running') setProgress(it);

  const bar = $('#bactions');
  const key = `${b.id}:${b.ended ? `end:${done}` : 'run'}`;
  if (bar.dataset.key === key) return; // keep focus on the buttons while the timer ticks
  bar.dataset.key = key;
  if (!b.ended) {
    bar.replaceChildren(btn('Cancel', 'x', { onclick: () => cancelAll(b) }));
    return;
  }
  const notSaved = b.items.filter((x) => x.state !== 'done').map((x) => x.url);
  bar.replaceChildren(...[
    done ? btn(`Download all (${done})`, 'down', { href: `/api/batches/${b.id}/zip`, class: 'btn primary', title: 'Download every saved page as one ZIP file' }) : null,
    notSaved.length ? btn(`Try ${notSaved.length} again`, 'redo', { title: 'Capture the pages that were not saved again', onclick: () => start(notSaved) }) : null,
    btn('Edit list', 'list', { title: 'Change the list and capture it again. Its pages are marked with how they went.', onclick: () => openList(b.items.map((x) => x.url).join('\n'), { from: b }) }),
    btn('New list', null, { class: 'btn ghost', title: 'Start an empty list. These captures stay in History.', onclick: newList }),
  ].filter(Boolean));
}

function cardSub(it) {
  if (it.cancelling) return 'Cancelling…';
  if (it.state === 'queued') {
    const start = batch?.sched?.get(it.id);
    return start === undefined ? 'Waiting' : start < 3000 ? 'Starts soon' : `Starts in ${fmtAbout(start)}`;
  }
  if (it.state === 'running') {
    return [STEP_ACTIVE[it.step] || 'Working', it.step === 'scroll' && it.progress != null ? `${Math.round(it.progress * 100)}%` : null,
      it.startedAt ? fmtElapsed(Date.now() - it.startedAt) : null].filter(Boolean).join(' · ');
  }
  if (it.state === 'done') return [fmtSize(it.entry.size), fmtMs(it.entry.ms), partsText(it.entry), it.entry.warnings?.length ? 'Check the result' : null].filter(Boolean).join(' · ');
  return it.error || 'Not saved';
}

const STATE_LABEL = { queued: 'Waiting', error: 'Failed', cancelled: 'Cancelled', done: 'Saved' };
const stateLabel = (it) => (it.state === 'running' ? STEP_ACTIVE[it.step] || 'Starting' : STATE_LABEL[it.state]);

// The buttons of a page: open and download when saved, cancel while it waits or runs.
function itemActions(it, name, { wide = false } = {}) {
  const c = it.entry;
  if (it.state === 'done') {
    return [
      c.files.length > 1
        ? btn('', 'down', { class: 'btn icon', href: zipUrl(c), title: `Download all ${c.files.length} parts as a ZIP file`, 'aria-label': `Download ${name}` })
        : btn('', 'down', { class: 'btn icon', href: fileUrl(c.files[0], true), title: 'Download', 'aria-label': `Download ${name}` }),
      btn('Open', null, { onclick: () => openCapture(it) }),
    ];
  }
  if (it.state === 'queued' || it.state === 'running') {
    return [btn(wide ? 'Cancel' : '', 'x', {
      class: `btn${wide ? '' : ' icon'}`, disabled: !!it.cancelling,
      title: it.state === 'queued' ? 'Cancel this page: it will not start' : 'Cancel this page',
      'aria-label': `Cancel ${name}`, onclick: () => cancelOne(it),
    })];
  }
  return [];
}

// One page as a row of the List layout: number, state, URL, details, buttons.
function renderRow(it) {
  const sub = cardSub(it);
  return el('div', { class: `brow ${it.state}${it.cancelling ? ' cancelling' : ''}`, 'data-id': it.id },
    el('span', { class: 'bn' }, String(it.n)),
    el('span', { class: 'bstate' },
      it.state === 'running' ? el('span', { class: 'spinner', 'aria-hidden': 'true' }) : el('span', { class: 'd', 'aria-hidden': 'true' }),
      stateLabel(it)),
    el('div', { class: 'bmain' },
      el('a', { class: 'name', href: it.url, target: '_blank', rel: 'noopener noreferrer', title: `Open ${it.url} in a new tab` }, it.url),
      el('div', { class: 'sub', title: sub }, sub)),
    el('div', { class: 'acts' }, ...itemActions(it, prettyUrl(it.url))),
    it.state === 'running' ? el('span', { class: 'bar' }) : null);
}

function renderCard(it) {
  if (view === 'rows') {
    placeCard(it, renderRow(it));
    return;
  }
  const name = prettyUrl(it.url);
  const c = it.entry;
  let thumb;
  if (it.state === 'done') {
    thumb = el('button', { class: 'thumb', type: 'button', onclick: () => openCapture(it), 'aria-label': `Open ${name}` },
      c.format === 'pdf' ? el('span', { class: 'pdf' }, 'PDF') : el('img', { src: fileUrl(c.files[0]), alt: '', loading: 'lazy' }),
      el('span', { class: 'fmt' }, c.format.toUpperCase()));
  } else {
    thumb = el('div', { class: 'thumb state' },
      it.state === 'running' ? el('span', { class: 'spinner', 'aria-hidden': 'true' }) : it.state === 'queued' ? null : icon('alert'),
      el('span', {}, stateLabel(it)),
      it.state === 'running' ? el('span', { class: 'bar' }) : null);
  }
  const sub = cardSub(it);
  const acts = itemActions(it, name, { wide: true });
  const card = el('div', { class: `card bcard ${it.state}${it.cancelling ? ' cancelling' : ''}`, 'data-id': it.id },
    thumb,
    el('div', { class: 'info' },
      el('div', { class: 'name', title: it.url }, name),
      el('div', { class: 'sub', title: sub }, sub)),
    acts.length ? el('div', { class: 'acts' }, ...acts) : null);
  placeCard(it, card);
}

// Put the new element of page `it` where its old one was (or at the end), and apply the filter.
function placeCard(it, node) {
  node.hidden = !shows(it);
  const old = cards.get(it.id);
  if (old) old.replaceWith(node); else $('#bgrid').append(node);
  cards.set(it.id, node);
  setProgress(it);
}

// The progress and time of a waiting or running page, without redrawing it.
function setProgress(it) {
  const card = cards.get(it.id);
  if (!card || (it.state !== 'running' && it.state !== 'queued')) return;
  const bar = card.querySelector('.bar');
  if (bar) bar.style.width = `${(it.progress ?? 0) * 100}%`;
  const sub = card.querySelector('.sub');
  const text = cardSub(it);
  if (sub.textContent !== text) { sub.textContent = text; sub.title = text; }
}

function openCapture(it) {
  showCapture(it.entry);
  setBack(true);
}

// "← Back to the list" over a capture opened from the list; "← New capture" otherwise.
export function setBack(on) {
  fromList = on;
  $('#jback').replaceChildren(icon('left'), on ? 'Back to the list' : 'New capture', el('kbd', {}, 'Esc'));
}

// The back link and Esc over a capture: true when they went back to the list.
export function backToList() {
  if (!fromList || !batch) return false;
  showBatch();
  return true;
}

export function initBatch() {
  area.addEventListener('input', () => { checkList(); store.patch({ list: area.value }); });
  area.addEventListener('scroll', () => { $('#bgutter').scrollTop = area.scrollTop; });
  area.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); goBtn.click(); }
  });
  goBtn.addEventListener('click', () => { const urls = checkList(); if (urls) start(urls); });
  $('#bfile').addEventListener('change', (e) => { loadFile(e.target.files[0]); e.target.value = ''; });
  $('#findform').addEventListener('submit', findSite);
  $('#bview').addEventListener('click', (e) => { const v = e.target.closest('[data-v]')?.dataset.v; if (v && v !== view) setView(v); });
  $('#fmode').value = store.load().findMode ?? 'auto';
  // While there is a last list, List shows its results; "New list" or "Edit list" leads on from there.
  $('#listbtn').addEventListener('click', () => (batch ? showBatch() : openList()));
  $('#listlink').addEventListener('click', () => (batch ? showBatch() : openList()));
  restoreList();
  // Several URLs pasted in the URL field open the list editor with them.
  urlInput.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text') ?? '';
    if (parseList(text).length < 2 || batchRunning()) return;
    e.preventDefault();
    const current = area.value.trim();
    openList(current ? `${current}\n${text.trim()}` : text.trim());
    toast('Several URLs were pasted, so they are in a list.');
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && batch?.ended) document.title = 'pagesnap'; });
}
