// DOM helpers: query shortcuts and small element builders.

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];

// el('a', { class: 'btn', href, onclick }, 'text', child) — "on*" keys become listeners.
export function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids) if (k != null) n.append(k);
  return n;
}

// An icon from the SVG sprite in index.html (<symbol id="i-…">).
export function icon(id) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  u.setAttribute('href', `#i-${id}`);
  s.append(u);
  return s;
}

// A button, or a link styled as one when attrs.href is set.
export const btn = (label, ic, attrs = {}) =>
  el(attrs.href ? 'a' : 'button', { class: 'btn', type: attrs.href ? null : 'button', ...attrs }, ic ? icon(ic) : null, label);
