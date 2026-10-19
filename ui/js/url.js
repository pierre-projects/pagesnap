// The URL field: checking what was typed, the error bubble under it, and the "/" shortcut.

import { $ } from './dom.js';
import * as store from './store.js';
import { saveForm } from './options.js';

export const urlInput = $('#url');

// Add a scheme when there is none. "localhost:3000" is host:port, not a scheme.
// Same rule as hasScheme() in lib/snap/options.js.
export const withScheme = (u) => (/^[a-z][a-z0-9+.-]*:/i.test(u) && !/^[^/:]+:[0-9]+([/?#]|$)/.test(u) ? u
  : `${/^(localhost|127\.|\[::1\])/i.test(u) ? 'http' : 'https'}://${u}`);

// Show `msg` under the field, or clear it.
export function urlError(msg) {
  const box = $('#urlerr');
  box.textContent = msg || '';
  box.hidden = !msg;
  if (msg) urlInput.setAttribute('aria-invalid', 'true'); else urlInput.removeAttribute('aria-invalid');
}

// A message for the person when `raw` cannot be captured, else null.
export function checkUrl(raw) {
  const s = raw.trim();
  if (!s) return 'Type a URL.';
  if (/\s/.test(s)) return 'The URL cannot contain spaces.';
  try {
    const u = new URL(withScheme(s));
    if (!['http:', 'https:', 'file:'].includes(u.protocol)) return `The URL must start with http, https, or file. "${u.protocol}" is not supported.`;
    if (u.protocol !== 'file:' && !u.hostname.includes('.') && u.hostname !== 'localhost') return 'The URL must have a full domain name, for example example.com.';
  } catch { return 'The URL is not valid.'; }
  return null;
}

export function initUrl() {
  const saved = store.load();
  if (saved.url) urlInput.value = saved.url;
  urlInput.addEventListener('input', () => { urlError(); saveForm(); });
  // "/" anywhere (outside a text field) jumps to the URL field.
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
    if (e.key === '/' && !typing) { e.preventDefault(); urlInput.focus(); urlInput.select(); }
  });
  urlInput.focus();
  urlInput.select();
}
