// Capturing a list of pages: one browser, a few pages at a time. Used by the CLI; the UI server
// runs list captures through its own job queue but shares the same helpers.

import { normalize, hostOf, hasScheme } from './options.js';
import { launch } from './browser.js';
import { snap } from './index.js';

// The most URLs one list may hold.
export const MAX_LIST = 200;

// The URLs in `text`, one on each line. Blank lines and lines that start with # are skipped,
// and a URL given twice is captured once. Same rule as parseList() in ui/js/batch.js.
export function parseUrlList(text) {
  const urls = String(text ?? '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
  return [...new Set(urls)];
}

// A file name for `url` that tells pages of one site apart: "example.com_docs_intro".
// Path parts are joined with "_" (not "-") so a number in the path is not taken for a split part.
export function pageSlug(url) {
  let parts = [];
  try {
    const u = new URL(hasScheme(url) ? url : `https://${url}`);
    if (u.protocol !== 'file:') parts = u.pathname.split('/').filter(Boolean);
    url = u.href;
  } catch { /* hostOf() falls back to "page" */ }
  const clean = (s) => decodeURIComponent(s).toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9.]+/g, '_').replace(/^_+|_+$/g, '');
  let slug = hostOf(url).replace(/[^a-z0-9.-]/gi, '_');
  for (const p of parts.map((s) => { try { return clean(s); } catch { return ''; } }).filter(Boolean)) {
    if (slug.length + p.length + 1 > 80) break;
    slug += `_${p}`;
  }
  return slug;
}

// Capture each of `items` (snap() inputs, each with its own url and out) with up to `parallel`
// pages loading at once. Never throws for one page: returns [{ url, files } | { url, error }]
// in the order of `items`. onStart(i) and onEnd(i, result) report each page; onLog(msg, i) gets
// each page's log lines (i is undefined for the browser launch).
export async function snapMany(items, { parallel = 3, onLog = () => {}, onStart = () => {}, onEnd = () => {}, signal } = {}) {
  const results = new Array(items.length);
  if (!items.length) return results;
  // Every page uses the browser of the first; the options are the same for the whole list.
  const browser = await launch(normalize(items[0]), (msg) => onLog(msg));
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      const { url } = items[i];
      if (signal?.aborted) { results[i] = { url, error: 'The capture was cancelled.' }; continue; }
      onStart(i);
      try {
        const r = await snap(items[i], { onLog: (msg) => onLog(msg, i), signal, browser });
        results[i] = { url, files: r.files, warnings: r.warnings };
      } catch (e) {
        results[i] = { url, error: e.message.split('\n')[0] };
      }
      onEnd(i, results[i]);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(parallel, items.length)) }, worker));
  } finally {
    await browser.close().catch(() => {});
  }
  return results;
}
