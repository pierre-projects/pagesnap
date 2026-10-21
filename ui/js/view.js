// The job panel on the Capture tab: header, meta line, notices. Shared by a running capture
// (capture.js) and a finished one (result.js). The Capture tab shows one of three panels:
// the start screen (#empty), one capture (#job), or a list capture (#batch).

import { $, el, icon } from './dom.js';
import { prettyUrl } from './format.js';

export function showJobView() {
  $('#empty').hidden = true;
  $('#batch').hidden = true;
  $('#job').hidden = false;
}

export function showEmpty() {
  $('#empty').hidden = false;
  $('#batch').hidden = true;
  $('#job').hidden = true;
}

// The list capture panel (batch.js) in place of the job panel.
export function showBatchView() {
  $('#empty').hidden = true;
  $('#job').hidden = true;
  $('#batch').hidden = false;
}

// Clear everything a previous capture left in the panel.
export function resetJobView() {
  $('#notices').replaceChildren();
  $('#log').replaceChildren();
  $('#logsum').textContent = 'Details';
  $('#logwrap').open = false;
  $('#logwrap').hidden = true;
  $('#previewwrap').hidden = true;
  $('#preview').replaceChildren();
  $('#jactions').replaceChildren();
  $('#steps').hidden = true;
  $('#framepanel').hidden = true;
}

// The page title above the meta line; http(s) URLs link to the page.
export function setHeader(url) {
  $('#jtitle').replaceChildren(/^https?:/.test(url)
    ? el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', title: url }, prettyUrl(url))
    : prettyUrl(url));
}

// A status pill: state is running | done | error | queued.
export const pill = (state, text) => el('span', { class: `pill ${state}` }, el('span', { class: 'd' }), text);

// The meta line under the title. The first item is always the status pill.
export function setMeta(...items) {
  $('#jmeta').replaceChildren(...items.filter(Boolean).map((x) => (typeof x === 'string' ? el('span', {}, x) : x)));
}

export function setPill(state, text) {
  $('#jmeta').firstChild?.replaceWith(pill(state, text));
}

// kind: error | warn. `action` is an optional button on the right.
export function notice(kind, title, text, action) {
  $('#notices').append(el('div', { class: `notice ${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    icon('alert'), el('div', { class: 'body' }, el('b', {}, title), text), action));
}
