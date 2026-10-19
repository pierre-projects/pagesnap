// Short status messages at the bottom of the screen.

import { $ } from './dom.js';

let timer;

export function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(timer);
  timer = setTimeout(() => t.classList.remove('show'), 2600);
}
