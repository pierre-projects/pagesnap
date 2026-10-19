// Light/dark theme: follows the system until the person picks one, then remembers it.

import { $ } from './dom.js';
import * as store from './store.js';

function apply(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

export function initTheme() {
  apply(store.load().theme);
  $('#theme').addEventListener('click', () => {
    const current = document.documentElement.dataset.theme
      || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    apply(next);
    store.patch({ theme: next });
  });
}
