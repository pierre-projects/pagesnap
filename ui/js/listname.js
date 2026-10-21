// List names: the default name of a list, renaming it in place, and saving the name.
// Used by the list view (batch.js) and the list groups in History (history.js).

import { el, icon } from './dom.js';
import { api } from './api.js';
import { emit } from './events.js';
import { toast } from './toast.js';

// Same limit as MAX_NAME in lib/server.js.
export const MAX_NAME = 80;

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

// The name of a list that has none: "example.com · 12 pages", or "12 pages from 3 sites".
export function defaultListName(urls) {
  const n = urls.length;
  const hosts = new Set(urls.map(hostOf));
  if (hosts.size <= 1) return `${[...hosts][0] ?? 'Empty list'} · ${n} ${n === 1 ? 'page' : 'pages'}`;
  return `${n} pages from ${hosts.size} sites`;
}

// Save the name of list `id` ('' gives back the default name). Tells every module with 'list-renamed'.
export async function saveListName(id, name) {
  await api(`/api/lists/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
  emit('list-renamed', id, name);
}

// The name as a button that turns into a text field: Enter or leaving the field saves, Esc cancels.
// `host` is the element that holds the name; onSave(name) must draw `host` again.
export function nameButton(host, { id, name, fallback }) {
  return el('button', {
    type: 'button', class: 'namebtn', title: 'Rename this list',
    onclick: () => renameInline(host, { name, fallback, onSave: (v) => saveListName(id, v) }),
  }, el('span', { class: 'nm' }, name || fallback), icon('edit'));
}

function renameInline(host, { name, fallback, onSave }) {
  const old = [...host.childNodes];
  const input = el('input', {
    type: 'text', class: 'renameinput', value: name, placeholder: fallback, maxlength: String(MAX_NAME),
    'aria-label': 'List name', spellcheck: 'false',
  });
  host.replaceChildren(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (!save || v === name) { host.replaceChildren(...old); return; }
    try { await onSave(v); } catch (e) { toast(e.message); host.replaceChildren(...old); }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}
