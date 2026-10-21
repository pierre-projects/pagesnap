// Short status messages at the bottom of the screen, with an optional button ("Undo").

import { $, el } from './dom.js';

let timer;

const hide = () => $('#toast').classList.remove('show', 'actionable');

// toast(msg) shows `msg` for a moment. With action: { label, onclick }, it also has a button
// and stays for `duration` ms.
export function toast(msg, { action, duration = action ? 6000 : 2600 } = {}) {
  const t = $('#toast');
  t.replaceChildren(el('span', {}, msg), ...(action
    ? [el('button', { type: 'button', class: 'toastbtn', onclick: () => { hide(); action.onclick(); } }, action.label)]
    : []));
  t.classList.add('show');
  t.classList.toggle('actionable', !!action);
  clearTimeout(timer);
  timer = setTimeout(hide, duration);
}
