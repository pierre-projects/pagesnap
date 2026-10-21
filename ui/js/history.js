// The History tab and the "Recent captures" list on the empty Capture tab. The captures of a list
// are grouped into one card; opening it shows them, with the list's name (click to rename).
// Selection mode deletes several captures, or whole lists, at once.

import { $, el, btn, icon } from './dom.js';
import { api, json, fileUrl, zipUrl } from './api.js';
import { ago, fmtSize, viewportLabel, partsText, frameText, captureTitle } from './format.js';
import { toast } from './toast.js';
import { showTab, whenShown } from './tabs.js';
import { on, emit } from './events.js';
import { showCapture, openFramePanel, canFrame } from './result.js';
import { defaultListName, nameButton } from './listname.js';

// How long a delete can be undone before the files are removed.
const UNDO_MS = 6000;

let captures = [];
let lists = {}; // list id -> { name, createdAt }
let openId = null; // the list open in History, or null for all captures
let selecting = false;
const selected = new Set(); // capture ids
let anchor = null; // the entry last clicked, where a Shift+click range starts
// Captures deleted but not yet removed on the server, while Undo is offered: { ids, timer }.
let pending = null;

// The captures to show: without the ones waiting to be deleted.
const live = () => (pending ? captures.filter((c) => !pending.ids.has(c.id)) : captures);

// ---------- lists ----------

// What History shows at the top: each list as one group, and the other captures, newest first.
// A group: { list: true, id, captures, createdAt, size }.
function entries() {
  const groups = new Map();
  const out = [];
  for (const c of live()) {
    if (!c.batch) { out.push(c); continue; }
    let g = groups.get(c.batch);
    if (!g) {
      g = { list: true, id: c.batch, captures: [], createdAt: 0, size: 0 };
      groups.set(c.batch, g);
      out.push(g); // at the place of its newest capture
    }
    g.captures.push(c);
    g.createdAt = Math.max(g.createdAt, c.createdAt || 0);
    g.size += c.size || 0;
  }
  return out;
}

const listName = (g) => lists[g.id]?.name || '';
const listFallback = (g) => defaultListName(g.captures.map((c) => c.url || c.id));
const groupById = (id) => entries().find((e) => e.list && e.id === id);
const keyOf = (e) => (e.list ? `list:${e.id}` : e.id);
const idsOf = (e) => (e.list ? e.captures.map((c) => c.id) : [e.id]);
const isSelected = (e) => idsOf(e).every((id) => selected.has(id));

const matches = (c, q) => `${c.url || ''} ${c.id}`.toLowerCase().includes(q);

// The entries in view: the open list's captures, or everything; filtered by the search.
function shownEntries() {
  const q = $('#hsearch').value.trim().toLowerCase();
  if (openId) {
    const g = groupById(openId);
    const list = g ? g.captures : [];
    return q ? list.filter((c) => matches(c, q)) : list;
  }
  const all = entries();
  if (!q) return all;
  return all.filter((e) => (e.list
    ? `${listName(e)} ${listFallback(e)}`.toLowerCase().includes(q) || e.captures.some((c) => matches(c, q))
    : matches(e, q)));
}

// Open list `id` in History (from a list card, or "Show in History" after a list).
function openGroup(id) {
  openId = id;
  selecting = false;
  selected.clear();
  anchor = null;
  $('#hsearch').value = '';
  showTab('history');
  render();
  $('#gback').focus();
}

function closeGroup() {
  const id = openId;
  openId = null;
  selecting = false;
  selected.clear();
  $('#hsearch').value = '';
  render();
  // Back on the card of the list that was open.
  $(`#grid [data-key="list:${CSS.escape(id ?? '')}"] .thumb`)?.focus();
}

// ---------- loading and drawing ----------

export async function loadHistory() {
  try {
    [captures, lists] = await Promise.all([api('/api/captures'), api('/api/lists').catch(() => ({}))]);
  } catch { return; }
  // A capture that is gone can't stay selected.
  const ids = new Set(captures.map((c) => c.id));
  for (const id of selected) if (!ids.has(id)) selected.delete(id);
  render();
}

function render() {
  // A list whose captures were all deleted closes.
  if (openId && !groupById(openId)) openId = null;
  $('#hcount').textContent = live().length;
  renderGroupHead();
  renderHistory();
  renderRecent();
  renderSelbar();
}

function renderRecent() {
  const list = live().slice(0, 4);
  $('#recent').hidden = !list.length;
  $('#recentlist').replaceChildren(...list.map((c) => el('button', { class: 'recentitem', type: 'button', onclick: () => showCapture(c) },
    el('span', { class: 'mini' }, c.format === 'pdf' ? 'PDF' : el('img', { src: fileUrl(c.files[0]), alt: '', loading: 'lazy' })),
    el('span', { class: 't' },
      el('b', {}, captureTitle(c)),
      el('small', {}, [ago(c.createdAt), c.format?.toUpperCase(), c.options ? viewportLabel(c.options) : null, frameText(c), partsText(c)].filter(Boolean).join(' · '))))));
}

// The header of an open list: its name (click to rename), counts, and its actions.
function renderGroupHead() {
  const g = openId && groupById(openId);
  $('#grouphead').hidden = !g;
  if (!g) return;
  const h = $('#gtitle');
  if (!h.querySelector('input')) h.replaceChildren(nameButton(h, { id: g.id, name: listName(g), fallback: listFallback(g) }));
  const n = g.captures.length;
  $('#gmeta').replaceChildren(...[
    el('span', { class: 'pill queued' }, icon('stack'), 'List'),
    `${n} ${n === 1 ? 'capture' : 'captures'}`,
    ago(lists[g.id]?.createdAt || g.createdAt),
    fmtSize(g.size),
  ].filter(Boolean).map((x) => (typeof x === 'string' ? el('span', {}, x) : x)));
  $('#gactions').replaceChildren(
    btn(`Download all (${n})`, 'down', { href: `/api/batches/${g.id}/zip`, class: 'btn primary', title: 'Download every capture of this list as one ZIP file' }),
    deleteButton(g, { wide: true }));
}

function renderHistory() {
  const all = live();
  const q = $('#hsearch').value.trim();
  const shown = shownEntries();
  const g = openId && groupById(openId);
  const total = g ? g.captures.length : entries().length;
  $('#hinfo').textContent = q ? `${shown.length} of ${total}`
    : g ? '' : all.length ? `${all.length} ${all.length === 1 ? 'capture' : 'captures'}` : '';
  $('#hsearch').placeholder = g ? 'Search this list' : 'Search captures';
  $('#hempty').hidden = shown.length > 0;
  $('#hemptytitle').textContent = q ? 'No captures match your search' : 'No captures yet';
  $('#hemptytext').textContent = q ? 'Try a different word.' : 'Your captures show here.';
  $('.histbar').hidden = !all.length;
  $('#history').classList.toggle('selecting', selecting);
  cardEls.clear();
  $('#grid').replaceChildren(...shown.map((e) => (e.list ? listCard(e) : card(e))));
}

// ---------- selection ----------

function startSelecting() {
  selecting = true;
  renderHistory();
  renderSelbar();
  $('#selall').focus();
}

function stopSelecting() {
  selecting = false;
  selected.clear();
  anchor = null;
  renderHistory();
  renderSelbar();
  $('#selstart').focus();
}

// Select or clear entry `e` (a capture, or a whole list). With Shift, everything shown between
// the last one clicked and `e` gets the same state as `e`.
function toggle(e, range) {
  const shown = shownEntries();
  const on = !isSelected(e);
  const a = shown.findIndex((x) => keyOf(x) === anchor);
  const b = shown.findIndex((x) => keyOf(x) === keyOf(e));
  const group = range && a >= 0 && b >= 0 ? shown.slice(Math.min(a, b), Math.max(a, b) + 1) : [e];
  for (const x of group) for (const id of idsOf(x)) if (on) selected.add(id); else selected.delete(id);
  anchor = keyOf(e);
  if (!selecting) { selecting = true; renderHistory(); }
  else for (const x of group) updateCard(x);
  renderSelbar();
}

function selectAllShown() {
  const shown = shownEntries();
  const all = shown.length > 0 && shown.every(isSelected);
  for (const e of shown) for (const id of idsOf(e)) if (all) selected.delete(id); else selected.add(id);
  renderHistory();
  renderSelbar();
}

function renderSelbar() {
  $('#selbar').hidden = !selecting;
  $('#selstart').hidden = selecting || !live().length;
  if (!selecting) return;
  const shown = shownEntries();
  const n = selected.size;
  const visible = new Set(shown.flatMap(idsOf));
  const hidden = [...selected].filter((id) => !visible.has(id)).length;
  $('#selcount').textContent = !n ? 'Select captures' : `${n} ${n === 1 ? 'capture' : 'captures'} selected${hidden ? ` · ${hidden} not shown` : ''}`;
  const all = shown.length > 0 && shown.every(isSelected);
  $('#selall').textContent = all ? 'Clear selection' : $('#hsearch').value.trim() ? `Select all ${shown.length} shown` : `Select all ${shown.length}`;
  $('#selall').disabled = !shown.length;
  const del = $('#seldelete');
  del.disabled = !n;
  del.replaceChildren(icon('trash'), n ? `Delete ${n}` : 'Delete');
}

// ---------- deleting ----------

// Delete these captures. They leave the screen at once; the files go after UNDO_MS, unless Undo
// is clicked (or Ctrl+Z pressed) first.
function deleteIds(ids, what) {
  if (!ids.length) return;
  commitPending(); // an earlier delete that is still waiting goes now
  pending = { ids: new Set(ids), timer: setTimeout(commitPending, UNDO_MS) };
  for (const id of ids) selected.delete(id);
  if (selecting && !selected.size) { selecting = false; anchor = null; }
  render();
  const n = ids.length;
  toast(what ?? `${n} ${n === 1 ? 'capture' : 'captures'} deleted.`, { action: { label: 'Undo', onclick: undoDelete }, duration: UNDO_MS });
}

function deleteSelected() {
  if (!selected.size) return;
  const ids = [...selected];
  selecting = false;
  selected.clear();
  anchor = null;
  deleteIds(ids);
}

function undoDelete() {
  if (!pending) return;
  clearTimeout(pending.timer);
  const n = pending.ids.size;
  pending = null;
  render();
  toast(`${n === 1 ? 'The capture is' : `The ${n} captures are`} back.`);
}

async function commitPending({ leaving = false } = {}) {
  if (!pending) return;
  const ids = [...pending.ids];
  clearTimeout(pending.timer);
  pending = null;
  if (leaving) {
    // The page is closing: keepalive lets the request finish without it.
    fetch('/api/captures/delete', { ...json({ ids }), keepalive: true }).catch(() => {});
    return;
  }
  try {
    const { missing } = await api('/api/captures/delete', json({ ids }));
    if (missing) toast(`${missing} of the captures were already gone.`);
  } catch (err) {
    toast(`The captures were not deleted. ${err.message}`);
  }
  emit('captures-changed');
}

// Two clicks to delete a capture or a whole list: the first arms the button, the second
// deletes, with Undo. No modal dialog.
function deleteButton(e, { wide = false } = {}) {
  const label = e.list ? `Delete the list ${listName(e) || listFallback(e)}` : `Delete ${captureTitle(e)}`;
  const idle = () => (wide ? [icon('trash'), e.list ? 'Delete list' : 'Delete'] : [icon('trash')]);
  const del = btn('', null, { class: `btn danger push${wide ? '' : ' icon'}`, title: e.list ? 'Delete this list and its captures' : 'Delete', 'aria-label': label });
  del.replaceChildren(...idle());
  let armed;
  const disarm = () => { armed = null; del.classList.remove('armed'); if (!wide) del.classList.add('icon'); del.replaceChildren(...idle()); };
  del.addEventListener('click', () => {
    if (!armed) {
      del.classList.add('armed');
      del.classList.remove('icon');
      del.replaceChildren(icon('trash'), e.list ? `Delete ${e.captures.length}?` : 'Delete?');
      armed = setTimeout(disarm, 3000);
      return;
    }
    clearTimeout(armed);
    const n = idsOf(e).length;
    deleteIds(idsOf(e), e.list ? `The list and its ${n} ${n === 1 ? 'capture' : 'captures'} are deleted.` : 'The capture is deleted.');
  });
  return del;
}

// ---------- cards ----------

const cardEls = new Map(); // entry key -> card element

function updateCard(e) {
  const old = cardEls.get(keyOf(e));
  if (old) old.replaceWith(e.list ? listCard(e) : card(e));
}

// The check box in the corner of a card. Shift+click selects a range; Space toggles it.
function pickBox(e, label) {
  const check = el('input', { type: 'checkbox', class: 'pick', 'aria-label': `Select ${label}` });
  check.checked = isSelected(e);
  check.addEventListener('click', (ev) => { ev.preventDefault(); toggle(e, ev.shiftKey); refocus(e); });
  return el('label', { class: 'pickbox', title: 'Select' }, check);
}

function card(c) {
  const isPdf = c.format === 'pdf';
  const title = captureTitle(c);
  const sub = [ago(c.createdAt), c.options ? viewportLabel(c.options) : null, frameText(c), fmtSize(c.size), partsText(c)].filter(Boolean).join(' · ');
  const isSel = isSelected(c);
  const node = el('div', { class: `card${isSel ? ' selected' : ''}`, 'data-key': keyOf(c) },
    pickBox(c, title),
    el('button', {
      class: 'thumb', type: 'button',
      'aria-label': selecting ? `${isSel ? 'Unselect' : 'Select'} ${title}` : `Open ${title}`,
      onclick: (ev) => (selecting ? (toggle(c, ev.shiftKey), refocus(c, '.thumb')) : showCapture(c)),
    },
    isPdf ? el('span', { class: 'pdf' }, 'PDF') : el('img', { src: fileUrl(c.files[0]), alt: '', loading: 'lazy' }),
    el('span', { class: 'fmt' }, (c.format || '').toUpperCase())),
    el('div', { class: 'info' },
      el('div', { class: 'name', title: c.url || c.id }, title),
      el('div', { class: 'sub', title: sub }, sub)),
    el('div', { class: 'acts' },
      c.files.length > 1
        ? btn('', 'down', { class: 'btn icon', href: zipUrl(c), title: `Download all ${c.files.length} parts as a ZIP file`, 'aria-label': 'Download all parts' })
        : btn('', 'down', { class: 'btn icon', href: fileUrl(c.files[0], true), title: 'Download', 'aria-label': 'Download' }),
      canFrame(c) ? btn('', 'phone', { class: 'btn icon', title: 'Frame this: put it in a device frame', 'aria-label': `Frame ${title}`, onclick: () => openFramePanel(c) }) : null,
      c.url ? btn('Again', 'redo', { title: 'Capture this URL again with the same options', onclick: () => emit('recapture', c) }) : null,
      deleteButton(c)));
  cardEls.set(keyOf(c), node);
  return node;
}

// A list as one card: up to four of its pages as a mosaic, its name, and how many captures.
function listCard(g) {
  const name = listName(g) || listFallback(g);
  const n = g.captures.length;
  const isSel = isSelected(g);
  const tiles = g.captures.slice(0, 4).map((c) => el('span', { class: 'tile' },
    c.format === 'pdf' ? el('span', { class: 'pdf' }, 'PDF') : el('img', { src: fileUrl(c.files[0]), alt: '', loading: 'lazy' })));
  const sub = [`${n} ${n === 1 ? 'capture' : 'captures'}`, ago(g.createdAt), fmtSize(g.size)].join(' · ');
  const node = el('div', { class: `card listcard${isSel ? ' selected' : ''}`, 'data-key': keyOf(g) },
    pickBox(g, `the list ${name}`),
    el('button', {
      class: 'thumb', type: 'button',
      'aria-label': selecting ? `${isSel ? 'Unselect' : 'Select'} the list ${name}` : `Open the list ${name}, ${n} captures`,
      onclick: (ev) => (selecting ? (toggle(g, ev.shiftKey), refocus(g, '.thumb')) : openGroup(g.id)),
    },
    el('span', { class: `mosaic n${tiles.length}` }, ...tiles),
    el('span', { class: 'fmt' }, icon('stack'), `LIST · ${n}`)),
    el('div', { class: 'info' },
      el('div', { class: 'name', title: name }, name),
      el('div', { class: 'sub', title: sub }, sub)),
    el('div', { class: 'acts' },
      btn('', 'down', { class: 'btn icon', href: `/api/batches/${g.id}/zip`, title: `Download all ${n} as a ZIP file`, 'aria-label': `Download the list ${name}` }),
      btn('Open', 'stack', { title: 'Show the captures of this list', onclick: () => openGroup(g.id) }),
      deleteButton(g)));
  cardEls.set(keyOf(g), node);
  return node;
}

// Keep the keyboard focus on the same control after its card was drawn again.
function refocus(e, sel = '.pick') {
  $(`#grid [data-key="${CSS.escape(keyOf(e))}"] ${sel}`)?.focus();
}

// ---------- setup ----------

const typing = () => /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) && !document.activeElement.classList.contains('pick');

export function initHistory() {
  $('#hsearch').addEventListener('input', () => { renderHistory(); renderSelbar(); });
  $('#selstart').addEventListener('click', () => startSelecting());
  $('#selclose').addEventListener('click', stopSelecting);
  $('#selall').addEventListener('click', selectAllShown);
  $('#seldelete').addEventListener('click', deleteSelected);
  $('#gback').addEventListener('click', closeGroup);
  document.addEventListener('keydown', (e) => {
    if ($('#history').hidden || e.defaultPrevented) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z' && pending && !typing()) { e.preventDefault(); undoDelete(); return; }
    if (typing()) return;
    if (!selecting) {
      if (e.key === 'Escape' && openId) { e.preventDefault(); closeGroup(); }
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); stopSelecting(); }
    else if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); selectAllShown(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && selected.size) { e.preventDefault(); deleteSelected(); }
  });
  // Leaving the page ends the Undo time: the delete is sent now.
  window.addEventListener('pagehide', () => commitPending({ leaving: true }));
  on('list-renamed', (id, name) => {
    lists[id] = { ...lists[id], name };
    if (openId === id) $('#gtitle').replaceChildren();
    render();
  });
  on('history-list', async (id) => { await loadHistory(); if (groupById(id)) openGroup(id); else showTab('history'); });
  whenShown('history', loadHistory);
  on('captures-changed', loadHistory);
  loadHistory();
}
