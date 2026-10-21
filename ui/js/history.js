// The History tab and the "Recent captures" list on the empty Capture tab, with selection mode
// for deleting several captures at once.

import { $, el, btn, icon } from './dom.js';
import { api, json, fileUrl, zipUrl } from './api.js';
import { ago, fmtSize, viewportLabel, partsText, frameText, captureTitle } from './format.js';
import { toast } from './toast.js';
import { whenShown } from './tabs.js';
import { on, emit } from './events.js';
import { showCapture, openFramePanel, canFrame } from './result.js';

// How long a bulk delete can be undone before the files are removed.
const UNDO_MS = 6000;

let captures = [];
let selecting = false;
const selected = new Set(); // capture ids
let anchor = null; // the capture last clicked, where a Shift+click range starts
// Captures deleted but not yet removed on the server, while Undo is offered: { ids, timer }.
let pending = null;

// The captures to show: without the ones waiting to be deleted.
const live = () => (pending ? captures.filter((c) => !pending.ids.has(c.id)) : captures);

function searchHits() {
  const q = $('#hsearch').value.trim().toLowerCase();
  const list = live();
  return q ? list.filter((c) => `${c.url || ''} ${c.id}`.toLowerCase().includes(q)) : list;
}

export async function loadHistory() {
  try { captures = await api('/api/captures'); } catch { return; }
  // A capture that is gone can't stay selected.
  const ids = new Set(captures.map((c) => c.id));
  for (const id of selected) if (!ids.has(id)) selected.delete(id);
  render();
}

function render() {
  $('#hcount').textContent = live().length;
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

function renderHistory() {
  const all = live();
  const q = $('#hsearch').value.trim();
  const shown = searchHits();
  $('#hinfo').textContent = q ? `${shown.length} of ${all.length}` : all.length ? `${all.length} ${all.length === 1 ? 'capture' : 'captures'}` : '';
  $('#hempty').hidden = shown.length > 0;
  $('#hemptytitle').textContent = q ? 'No captures match your search' : 'No captures yet';
  $('#hemptytext').textContent = q ? 'Try a different word.' : 'Your captures show here.';
  $('.histbar').hidden = !all.length;
  $('#history').classList.toggle('selecting', selecting);
  cardEls.clear();
  $('#grid').replaceChildren(...shown.map(card));
}

// ---------- selection ----------

function startSelecting(first) {
  selecting = true;
  if (first) { selected.add(first.id); anchor = first.id; }
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

// Select or clear capture `c`. With Shift, everything shown between the last one clicked and
// `c` gets the same state as `c`.
function toggle(c, range) {
  const shown = searchHits();
  const on = !selected.has(c.id);
  const a = shown.findIndex((x) => x.id === anchor);
  const b = shown.findIndex((x) => x.id === c.id);
  const group = range && a >= 0 && b >= 0 ? shown.slice(Math.min(a, b), Math.max(a, b) + 1) : [c];
  for (const x of group) if (on) selected.add(x.id); else selected.delete(x.id);
  anchor = c.id;
  if (!selecting) { selecting = true; renderHistory(); }
  else for (const x of group) updateCard(x);
  renderSelbar();
}

function selectAllShown() {
  const shown = searchHits();
  const all = shown.length > 0 && shown.every((c) => selected.has(c.id));
  for (const c of shown) if (all) selected.delete(c.id); else selected.add(c.id);
  renderHistory();
  renderSelbar();
}

function renderSelbar() {
  $('#selbar').hidden = !selecting;
  $('#selstart').hidden = selecting || !live().length;
  if (!selecting) return;
  const shown = searchHits();
  const n = selected.size;
  const hidden = [...selected].filter((id) => !shown.some((c) => c.id === id)).length;
  $('#selcount').textContent = !n ? 'Select captures' : `${n} selected${hidden ? ` · ${hidden} not shown by the search` : ''}`;
  const all = shown.length > 0 && shown.every((c) => selected.has(c.id));
  $('#selall').textContent = all ? 'Clear selection' : $('#hsearch').value.trim() ? `Select all ${shown.length} shown` : `Select all ${shown.length}`;
  $('#selall').disabled = !shown.length;
  const del = $('#seldelete');
  del.disabled = !n;
  del.replaceChildren(icon('trash'), n ? `Delete ${n}` : 'Delete');
}

// ---------- deleting ----------

// Delete the selected captures. They leave the screen at once; the files go after UNDO_MS,
// unless Undo is clicked (or Ctrl+Z pressed) first.
function deleteSelected() {
  if (!selected.size) return;
  commitPending(); // an earlier delete that is still waiting goes now
  const ids = new Set(selected);
  pending = { ids, timer: setTimeout(commitPending, UNDO_MS) };
  selecting = false;
  selected.clear();
  anchor = null;
  render();
  const n = ids.size;
  toast(`${n} ${n === 1 ? 'capture' : 'captures'} deleted.`, { action: { label: 'Undo', onclick: undoDelete }, duration: UNDO_MS });
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

// Two clicks to delete: the first arms the button, the second deletes. No modal dialog.
function deleteButton(c) {
  const del = btn('', 'trash', { class: 'btn icon danger push', title: 'Delete', 'aria-label': `Delete ${captureTitle(c)}` });
  let armed;
  const disarm = () => { armed = null; del.classList.remove('armed'); del.classList.add('icon'); del.replaceChildren(icon('trash')); };
  del.addEventListener('click', async () => {
    if (!armed) {
      del.classList.add('armed');
      del.classList.remove('icon');
      del.replaceChildren(icon('trash'), 'Delete?');
      armed = setTimeout(disarm, 3000);
      return;
    }
    clearTimeout(armed);
    try {
      await api(`/api/captures/${encodeURIComponent(c.id)}`, { method: 'DELETE' });
      toast('The capture is deleted.');
    } catch (err) { toast(err.message); }
    emit('captures-changed');
  });
  return del;
}

// ---------- cards ----------

const cardEls = new Map(); // id -> card element

function updateCard(c) {
  const old = cardEls.get(c.id);
  if (old) old.replaceWith(card(c));
}

function card(c) {
  const isPdf = c.format === 'pdf';
  const title = captureTitle(c);
  const sub = [ago(c.createdAt), c.options ? viewportLabel(c.options) : null, frameText(c), fmtSize(c.size), partsText(c)].filter(Boolean).join(' · ');
  const isSel = selected.has(c.id);
  const check = el('input', { type: 'checkbox', class: 'pick', 'aria-label': `Select ${title}` });
  check.checked = isSel;
  // Clicking the box selects; Shift+click selects a range. Keyboard: Space toggles it.
  check.addEventListener('click', (e) => { e.preventDefault(); toggle(c, e.shiftKey); refocus(c); });
  const node = el('div', { class: `card${isSel ? ' selected' : ''}`, 'data-id': c.id },
    el('label', { class: 'pickbox', title: 'Select' }, check),
    el('button', {
      class: 'thumb', type: 'button',
      'aria-label': selecting ? `${isSel ? 'Unselect' : 'Select'} ${title}` : `Open ${title}`,
      onclick: (e) => (selecting ? (toggle(c, e.shiftKey), refocus(c, '.thumb')) : showCapture(c)),
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
  cardEls.set(c.id, node);
  return node;
}

// Keep the keyboard focus on the same control after its card was drawn again.
function refocus(c, sel = '.pick') {
  $(`#grid [data-id="${CSS.escape(c.id)}"] ${sel}`)?.focus();
}

// ---------- setup ----------

const typing = () => /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) && !document.activeElement.classList.contains('pick');

export function initHistory() {
  $('#hsearch').addEventListener('input', () => { renderHistory(); renderSelbar(); });
  $('#selstart').addEventListener('click', () => startSelecting());
  $('#selclose').addEventListener('click', stopSelecting);
  $('#selall').addEventListener('click', selectAllShown);
  $('#seldelete').addEventListener('click', deleteSelected);
  document.addEventListener('keydown', (e) => {
    if ($('#history').hidden || e.defaultPrevented) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z' && pending && !typing()) { e.preventDefault(); undoDelete(); return; }
    if (!selecting || typing()) return;
    if (e.key === 'Escape') { e.preventDefault(); stopSelecting(); }
    else if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); selectAllShown(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && selected.size) { e.preventDefault(); deleteSelected(); }
  });
  // Leaving the page ends the Undo time: the delete is sent now.
  window.addEventListener('pagehide', () => commitPending({ leaving: true }));
  whenShown('history', loadHistory);
  on('captures-changed', loadHistory);
  loadHistory();
}
