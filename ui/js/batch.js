// Capturing a list of pages: the list editor, then a grid with one card per page that follows
// the whole list over one SSE stream (/api/batches/:id/events).

import { $, el, btn, icon } from './dom.js';
import { api, json, fileUrl, zipUrl } from './api.js';
import { fmtMs, fmtSize, prettyUrl, viewportLabel, partsText } from './format.js';
import { toast } from './toast.js';
import { showTab } from './tabs.js';
import { emit } from './events.js';
import * as store from './store.js';
import { buildRequest, saveForm, closeOptions } from './options.js';
import { urlInput, checkUrl } from './url.js';
import { showBatchView, pill } from './view.js';
import { showCapture } from './result.js';

// Same limit as MAX_LIST in lib/snap/batch.js.
const MAX_LIST = 200;
const STEP_ACTIVE = { load: 'Loading', cookies: 'Cleaning up', scroll: 'Scrolling', capture: 'Saving' };

const area = $('#blist');
const goBtn = $('#bgo');

let batch = null; // the list on screen: { id, req, started, items, ended, es, timer }
let fromList = false; // the capture on screen was opened from the list's grid
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
export function openList(text) {
  showTab('result');
  if (batchRunning()) { showBatch(); return; }
  setBack(false);
  showBatchView();
  $('#bcompose').hidden = false;
  $('#brun').hidden = true;
  if (text !== undefined) area.value = text;
  else if (!area.value) area.value = store.load().list ?? '';
  checkList();
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
  $('#bcount').textContent = !n ? 'Type or paste one URL on each line.'
    : n > MAX_LIST ? `${n} URLs. The most is ${MAX_LIST}: split the list.`
    : `${n} ${n === 1 ? 'URL' : 'URLs'}${bad.length ? `, ${bad.length} not valid` : ''}`;

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
    items: res.jobs.map((j) => ({ id: j.id, url: j.url, state: 'queued' })),
  };
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
  else if (type === 'step') { it.state = 'running'; it.step = data; it.progress = null; }
  else if (type === 'progress') {
    it.progress = Math.min(1, data.y / data.height);
    if (b === batch) setProgress(it);
    return;
  } else if (type === 'done') {
    it.state = 'done';
    it.entry = data;
    // History and its badge, at most once a second while pages finish.
    clearTimeout(changedTimer);
    changedTimer = setTimeout(() => emit('captures-changed'), 1000);
  } else if (type === 'error') {
    it.state = data.cancelled ? 'cancelled' : 'error';
    it.error = data.message;
  }
  if (b !== batch) return;
  renderCard(it);
  renderHead(b);
}

function finish(b) {
  if (b.ended) return;
  b.ended = true;
  b.endedAt = Date.now();
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
  cards.clear();
  $('#bgrid').replaceChildren();
  batch.items.forEach(renderCard);
  renderHead(batch);
}

function renderHead(b) {
  const n = b.items.length;
  const count = (s) => b.items.filter((x) => x.state === s).length;
  const done = count('done');
  const failed = count('error');
  const cancelled = count('cancelled');
  const finished = done + failed + cancelled;
  $('#btitle').textContent = `List of ${n} ${n === 1 ? 'page' : 'pages'}`;
  const secs = Math.round(((b.endedAt ?? Date.now()) - b.started) / 1000);
  const status = !b.ended ? pill('running', `Capturing · ${finished} of ${n} done`)
    : done === n ? pill('done', n === 1 ? 'Saved' : `All ${n} saved`)
    : !done ? pill('error', cancelled === n ? 'Cancelled' : 'Nothing saved')
    : pill('error', `${done} saved · ${n - done} not saved`);
  $('#bmeta').replaceChildren(status, ...[
    `${secs} s`,
    failed && !b.ended ? `${failed} failed` : null,
    viewportLabel(b.req),
    b.req.format.toUpperCase(),
  ].filter(Boolean).map((t) => el('span', {}, t)));
  $('#bbar').style.width = `${(finished / n) * 100}%`;
  $('#boverall').setAttribute('aria-valuenow', String(Math.round((finished / n) * 100)));
  $('#boverall').classList.toggle('ended', b.ended && done === n);
  if (!b.ended && !document.hidden) document.title = `Capturing ${finished}/${n}… · pagesnap`;

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
    btn('Edit list', 'list', { onclick: () => openList(b.items.map((x) => x.url).join('\n')) }),
  ].filter(Boolean));
}

function cardSub(it) {
  if (it.state === 'queued') return it.ahead ? `Waiting · ${it.ahead} ahead` : 'Waiting';
  if (it.state === 'running') return `${STEP_ACTIVE[it.step] || 'Working'}${it.step === 'scroll' && it.progress != null ? ` · ${Math.round(it.progress * 100)}%` : ''}`;
  if (it.state === 'done') return [fmtSize(it.entry.size), fmtMs(it.entry.ms), partsText(it.entry), it.entry.warnings?.length ? 'Check the result' : null].filter(Boolean).join(' · ');
  return it.error || 'Not saved';
}

function renderCard(it) {
  const name = prettyUrl(it.url);
  const c = it.entry;
  let thumb;
  if (it.state === 'done') {
    thumb = el('button', { class: 'thumb', type: 'button', onclick: () => openCapture(it), 'aria-label': `Open ${name}` },
      c.format === 'pdf' ? el('span', { class: 'pdf' }, 'PDF') : el('img', { src: fileUrl(c.files[0]), alt: '', loading: 'lazy' }),
      el('span', { class: 'fmt' }, c.format.toUpperCase()));
  } else {
    const label = { queued: 'Waiting', running: STEP_ACTIVE[it.step] || 'Starting', error: 'Failed', cancelled: 'Cancelled' }[it.state];
    thumb = el('div', { class: 'thumb state' },
      it.state === 'running' ? el('span', { class: 'spinner', 'aria-hidden': 'true' }) : it.state === 'queued' ? null : icon('alert'),
      el('span', {}, label),
      it.state === 'running' ? el('span', { class: 'bar' }) : null);
  }
  const sub = cardSub(it);
  const card = el('div', { class: `card bcard ${it.state}`, 'data-id': it.id },
    thumb,
    el('div', { class: 'info' },
      el('div', { class: 'name', title: it.url }, name),
      el('div', { class: 'sub', title: sub }, sub)),
    it.state === 'done' ? el('div', { class: 'acts' },
      c.files.length > 1
        ? btn('', 'down', { class: 'btn icon', href: zipUrl(c), title: `Download all ${c.files.length} parts as a ZIP file`, 'aria-label': `Download ${name}` })
        : btn('', 'down', { class: 'btn icon', href: fileUrl(c.files[0], true), title: 'Download', 'aria-label': `Download ${name}` }),
      btn('Open', null, { onclick: () => openCapture(it) })) : null);
  const old = cards.get(it.id);
  if (old) old.replaceWith(card); else $('#bgrid').append(card);
  cards.set(it.id, card);
  setProgress(it);
}

// The scroll progress of a running page, without redrawing its card.
function setProgress(it) {
  const card = cards.get(it.id);
  if (!card || it.state !== 'running') return;
  const bar = card.querySelector('.thumb .bar');
  if (bar) bar.style.width = `${(it.progress ?? 0) * 100}%`;
  card.querySelector('.sub').textContent = cardSub(it);
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
  area.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); goBtn.click(); }
  });
  goBtn.addEventListener('click', () => { const urls = checkList(); if (urls) start(urls); });
  $('#bfile').addEventListener('change', (e) => { loadFile(e.target.files[0]); e.target.value = ''; });
  $('#listbtn').addEventListener('click', () => (batch && !batch.ended ? showBatch() : openList()));
  $('#listlink').addEventListener('click', () => openList());
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
