// The History tab and the "Recent captures" list on the empty Capture tab.

import { $, el, btn, icon } from './dom.js';
import { api, fileUrl, zipUrl } from './api.js';
import { ago, fmtSize, viewportLabel, partsText, frameText, captureTitle } from './format.js';
import { toast } from './toast.js';
import { whenShown } from './tabs.js';
import { on, emit } from './events.js';
import { showCapture, openFramePanel, canFrame } from './result.js';

let captures = [];

export async function loadHistory() {
  try { captures = await api('/api/captures'); } catch { return; }
  $('#hcount').textContent = captures.length;
  renderHistory();
  renderRecent();
}

function renderRecent() {
  const list = captures.slice(0, 4);
  $('#recent').hidden = !list.length;
  $('#recentlist').replaceChildren(...list.map((c) => el('button', { class: 'recentitem', type: 'button', onclick: () => showCapture(c) },
    el('span', { class: 'mini' }, c.format === 'pdf' ? 'PDF' : el('img', { src: fileUrl(c.files[0]), alt: '', loading: 'lazy' })),
    el('span', { class: 't' },
      el('b', {}, captureTitle(c)),
      el('small', {}, [ago(c.createdAt), c.format?.toUpperCase(), c.options ? viewportLabel(c.options) : null, frameText(c), partsText(c)].filter(Boolean).join(' · '))))));
}

function renderHistory() {
  const q = $('#hsearch').value.trim().toLowerCase();
  const shown = q ? captures.filter((c) => `${c.url || ''} ${c.id}`.toLowerCase().includes(q)) : captures;
  $('#hinfo').textContent = q ? `${shown.length} of ${captures.length}` : captures.length ? `${captures.length} ${captures.length === 1 ? 'capture' : 'captures'}` : '';
  $('#hempty').hidden = shown.length > 0;
  $('#hemptytitle').textContent = q ? 'No captures match your search' : 'No captures yet';
  $('#hemptytext').textContent = q ? 'Try a different word.' : 'Your captures show here.';
  $('.histbar').hidden = !captures.length;
  $('#grid').replaceChildren(...shown.map(card));
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

function card(c) {
  const isPdf = c.format === 'pdf';
  const sub = [ago(c.createdAt), c.options ? viewportLabel(c.options) : null, frameText(c), fmtSize(c.size), partsText(c)].filter(Boolean).join(' · ');
  return el('div', { class: 'card' },
    el('button', { class: 'thumb', type: 'button', onclick: () => showCapture(c), 'aria-label': `Open ${captureTitle(c)}` },
      isPdf ? el('span', { class: 'pdf' }, 'PDF') : el('img', { src: fileUrl(c.files[0]), alt: '', loading: 'lazy' }),
      el('span', { class: 'fmt' }, (c.format || '').toUpperCase())),
    el('div', { class: 'info' },
      el('div', { class: 'name', title: c.url || c.id }, captureTitle(c)),
      el('div', { class: 'sub', title: sub }, sub)),
    el('div', { class: 'acts' },
      c.files.length > 1
        ? btn('', 'down', { class: 'btn icon', href: zipUrl(c), title: `Download all ${c.files.length} parts as a ZIP file`, 'aria-label': 'Download all parts' })
        : btn('', 'down', { class: 'btn icon', href: fileUrl(c.files[0], true), title: 'Download', 'aria-label': 'Download' }),
      canFrame(c) ? btn('', 'phone', { class: 'btn icon', title: 'Frame this: put it in a device frame', 'aria-label': `Frame ${captureTitle(c)}`, onclick: () => openFramePanel(c) }) : null,
      c.url ? btn('Again', 'redo', { title: 'Capture this URL again with the same options', onclick: () => emit('recapture', c) }) : null,
      deleteButton(c)));
}

export function initHistory() {
  $('#hsearch').addEventListener('input', renderHistory);
  whenShown('history', loadHistory);
  on('captures-changed', loadHistory);
  loadHistory();
}
