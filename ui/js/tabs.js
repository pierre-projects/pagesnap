// The Capture / History tabs.

import { $, $$ } from './dom.js';

const onShow = new Map();

// Run `fn` each time tab `name` is shown (history.js reloads the list this way).
export function whenShown(name, fn) { onShow.set(name, fn); }

export function showTab(name) {
  $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
  $('#result').hidden = name !== 'result';
  $('#history').hidden = name !== 'history';
  onShow.get(name)?.();
}

export function initTabs() {
  $$('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
  $('#seeall').addEventListener('click', () => showTab('history'));
}
