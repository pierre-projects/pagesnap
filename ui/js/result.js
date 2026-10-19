// A finished capture: its toolbar (download, copy, folder, capture again) and the preview with zoom.

import { $, $$, el, btn } from './dom.js';
import { api, json, fileUrl, zipUrl } from './api.js';
import { ago, fmtMs, fmtPx, fmtSize, viewportLabel, partsText, frameText, clockNow, SPLIT_NOUN } from './format.js';
import { toast } from './toast.js';
import { showTab } from './tabs.js';
import { emit, on } from './events.js';
import { frameElement, screenUrl, autoFrame } from './frameview.js';
import { showJobView, resetJobView, setHeader, setMeta, pill, notice } from './view.js';

const framed = (c) => !!c.frame && c.frame !== 'none';

// Whether "Frame this" can put capture `c` in a device frame: it must be one continuous strip of
// page images with no frame yet. Same rule as frameableProblem() in lib/server.js.
export const canFrame = (c) => c.format !== 'pdf' && !framed(c) && c.split !== 'elements';

// A framed capture that kept its unframed screens: its frame and background can change at once.
const live = (c) => framed(c) && !!c.screens?.length && !!c.framing;

let shown = null; // the capture on the Capture tab
let edit = null; // { frame, bg } of a live capture, as it is drawn now
let saveTimer = null;
let saving = null; // the PATCH in progress, if any

// Show capture `c` (a history entry). `fresh` means it was just saved, so the panel already has
// this capture's log and must not be cleared.
export function showCapture(c, { fresh = false } = {}) {
  showTab('result');
  showJobView();
  if (!fresh) resetJobView();
  setHeader(c.url || c.id);
  setMeta(
    pill('done', fresh ? 'Saved' : ago(c.createdAt)),
    c.ms ? fmtMs(c.ms) : null,
    // A frame holds one screen, so the page height says nothing about the image.
    c.height && !framed(c) ? `${fmtPx(c.height)} tall` : null,
    c.options ? viewportLabel(c.options) : null,
    frameText(c),
    partsText(c),
    c.size ? fmtSize(c.size) : null,
  );
  (c.warnings || []).forEach((w) => notice('warn', 'Check the result.', w));
  if (shown !== c) { clearTimeout(saveTimer); setStatus(''); }
  shown = c;
  edit = live(c) ? {
    frame: c.frame, bg: c.framing.bg || c.options?.frameBg || 'transparent', time: c.framing.time ?? '9:41', date: c.framing.date ?? 'Tue Jan 9',
  } : null;
  renderToolbar(c);
  showStrip(c);
  renderPreview(c);
}

function renderToolbar(c) {
  const isPdf = c.format === 'pdf';
  const bar = $('#jactions');
  bar.replaceChildren();
  // Several parts download as one ZIP. Each part also has its own download button in the preview.
  if (c.files.length === 1) bar.append(btn('Download', 'down', { href: fileUrl(c.files[0], true), class: 'btn primary' }));
  else bar.append(btn(`Download all (${c.files.length})`, 'down', { href: zipUrl(c), class: 'btn primary', title: 'Download all parts as one ZIP file' }));
  if (!isPdf && c.files.length === 1 && window.ClipboardItem) {
    bar.append(btn('Copy', 'copy', { onclick: () => copyImage(c.files[0]), title: 'Copy the image to the clipboard' }));
  }
  bar.append(btn('', 'folder', { class: 'btn icon', title: 'Show the file in its folder', 'aria-label': 'Show the file in its folder', onclick: () => reveal(c.files[0]) }));
  bar.append(btn('', 'ext', { class: 'btn icon', href: fileUrl(c.files[0]), target: '_blank', rel: 'noopener', title: 'Open the file in a new tab', 'aria-label': 'Open the file in a new tab' }));
  if (c.url || canFrame(c)) bar.append(el('span', { class: 'sep' }));
  if (canFrame(c)) {
    bar.append(btn('Frame this', 'phone', { title: 'Put this capture in a device frame. The site does not load again.', onclick: () => openFramePanel(c) }));
  }
  if (c.url) {
    bar.append(btn('Capture again', 'redo', { title: 'Capture this URL again with the same options', onclick: () => emit('recapture', c) }));
  }
}

// ---------- "Frame this" ----------
let framing = null; // the capture the frame panel is for

function frameHint() {
  $('#fpHint').textContent = $('#fpEvery').checked
    ? 'Each screen goes in a frame. Fixed headers show only on the first screen. For headers on every screen, use Capture again with a frame.'
    : 'The first screen goes in a frame. pagesnap uses this capture and does not load the site again.';
}

// Open the frame options for capture `c` (shows it first when it is not on screen).
export function openFramePanel(c) {
  if (!canFrame(c)) return;
  if (framing !== c) showCapture(c);
  framing = c;
  // Start from the sidebar's frame choice when one is set.
  const side = document.querySelector('#opts select[name="frame"]')?.value;
  $('#fpFrame').value = side && side !== 'none' ? side : 'auto';
  const sideBg = document.querySelector('#opts input[name="frameBg"]:checked')?.value || 'transparent';
  $$('input[name="fpBg"]').forEach((i) => { i.checked = i.value === sideBg; });
  $('#fpEvery').checked = false;
  frameHint();
  $('#framepanel').hidden = false;
  $('#fpFrame').focus();
}

function closeFramePanel() {
  $('#framepanel').hidden = true;
}

function renderPreview(c) {
  const pv = $('#preview');
  const isPdf = c.format === 'pdf';
  pv.replaceChildren();
  pv.className = `preview${isPdf ? ' pdf' : ''}`;
  $('#zoom').hidden = isPdf;
  $('#pvinfo').textContent = '';
  if (isPdf) {
    pv.append(el('iframe', { src: fileUrl(c.files[0]), title: 'PDF preview' }));
    $('#previewwrap').hidden = false;
    return;
  }
  if (live(c)) { renderLive(c); return; }
  // Show at the page's own CSS width (pixels ÷ density), so 3× phone captures don't fill a desktop screen.
  const dpr = c.dpr || c.options?.scale || 1;
  // A split capture shows its parts as separate cards. A tall page that was only cut to fit
  // the size limit shows as one continuous image.
  const split = c.split && c.split !== 'none';
  const stack = el('div', { class: `stack${split ? ' split' : ''}${framed(c) ? ' framed' : ''}`, 'data-dpr': dpr });
  const labels = new Map((c.parts || []).map((p) => [p.file, p.label]));
  c.files.forEach((f, i) => {
    const img = el('img', { src: fileUrl(f), alt: `Capture of ${c.url || f}${c.files.length > 1 ? `, part ${i + 1}` : ''}`, title: 'Click to change the zoom' });
    img.addEventListener('load', () => {
      sizeImage(img);
      const tall = c.height && !framed(c) ? Math.round(c.height * dpr) : img.naturalHeight;
      if (i === 0 && !split) $('#pvinfo').textContent = `${img.naturalWidth.toLocaleString()} × ${tall.toLocaleString()} px image`;
    });
    if (c.files.length === 1) { stack.append(img); return; }
    const raw = labels.get(f);
    const name = raw ? raw[0].toUpperCase() + raw.slice(1) : `Part ${i + 1}`;
    const head = el('div', { class: 'partlabel' },
      el('span', { class: 'pn' }, String(i + 1)),
      el('span', { class: 'pt', title: f }, name),
      btn('', 'down', { class: 'btn icon', href: fileUrl(f, true), title: `Download ${f}`, 'aria-label': `Download part ${i + 1}` }));
    stack.append(split ? el('div', { class: 'part' }, head, img) : el('div', {}, head, img));
  });
  if (split) $('#pvinfo').textContent = `${c.files.length} ${SPLIT_NOUN[c.split]}`;
  pv.append(stack);
  pv.onclick = (e) => { if (e.target.tagName === 'IMG') setZoom(pv.classList.contains('actual') ? 'fit' : 'actual', e); };
  setZoom('fit');
  $('#previewwrap').hidden = false;
}

// z: fit | actual. With a click event, the clicked point stays under the cursor.
function setZoom(z, ev) {
  const pv = $('#preview');
  const stack = $('.stack', pv);
  const rect = pv.getBoundingClientRect();
  const fx = ev ? (ev.clientX - rect.left + pv.scrollLeft) / pv.scrollWidth : 0;
  const fy = ev ? (ev.clientY - rect.top + pv.scrollTop) / pv.scrollHeight : 0;
  pv.classList.toggle('actual', z === 'actual');
  $$('#zoom button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.z === z)));
  if (stack) $$('img', stack).forEach(sizeImage);
  if (stack) $$('.livestage', stack).forEach(sizeLive);
  if (ev) {
    pv.scrollLeft = fx * pv.scrollWidth - (ev.clientX - rect.left);
    pv.scrollTop = fy * pv.scrollHeight - (ev.clientY - rect.top);
  }
}

// Fit: the page's CSS width (pixels ÷ density), shrunk to the panel by max-width. Actual: one image pixel per screen pixel.
function sizeImage(img) {
  if (!img.naturalWidth) return;
  const dpr = Number(img.closest('.stack')?.dataset.dpr) || 1;
  const actual = $('#preview').classList.contains('actual');
  let width = actual ? img.naturalWidth : img.naturalWidth / dpr;
  // A device frame is a picture of one screen: in Fit, show all of it, not only its full width.
  if (!actual && img.closest('.stack.framed')) {
    const room = $('#preview').clientHeight - 32 - (img.previousElementSibling?.offsetHeight || 0);
    if (room > 100) width = Math.min(width, room * (img.naturalWidth / img.naturalHeight));
  }
  img.style.width = `${width}px`;
}

// ---------- live frames ----------

// Draw a live capture's screens in its current frame and background (edit), in the browser.
function renderLive(c) {
  const pv = $('#preview');
  const { w, h, host, dark, dpr } = c.framing;
  const stack = el('div', { class: 'stack live', 'data-dpr': dpr });
  c.screens.forEach((sc, i) => {
    const stage = frameElement(edit.frame, { img: screenUrl(sc.raw), w, h, host, top: sc.top, dark: dark || sc.top?.dark, bg: edit.bg, time: clockOf(edit.time), date: edit.date });
    stage.title = 'Click to change the zoom';
    if (c.screens.length === 1) { stack.append(stage); return; }
    const head = el('div', { class: 'partlabel' },
      el('span', { class: 'pn' }, String(i + 1)),
      el('span', { class: 'pt', title: c.files[i] }, `Screen ${i + 1}`),
      btn('', 'down', { class: 'btn icon', href: fileUrl(c.files[i], true), title: `Download ${c.files[i]}`, 'aria-label': `Download screen ${i + 1}` }));
    stack.append(el('div', { class: 'part' }, head, stage));
  });
  $('#pvinfo').textContent = c.screens.length > 1 ? `${c.screens.length} screens` : '';
  pv.append(stack);
  pv.onclick = (e) => {
    if (e.target.closest?.('.livestage')) setZoom(pv.classList.contains('actual') ? 'fit' : 'actual', e);
  };
  // Show the preview first: the frames can only be measured once they are on screen.
  $('#previewwrap').hidden = false;
  setZoom(pv.classList.contains('actual') ? 'actual' : 'fit');
}

// Fit: the whole frame in the preview. Actual: one image pixel per screen pixel (zoom = density).
function sizeLive(stage) {
  const pv = $('#preview');
  const dpr = Number(stage.closest('.stack')?.dataset.dpr) || 1;
  stage.style.zoom = '1';
  const r = stage.getBoundingClientRect();
  // Not laid out yet (the tab is hidden, or the panel is still opening): try again next frame.
  if (!r.width || !pv.clientWidth) { requestAnimationFrame(() => { if (stage.isConnected && pv.clientWidth) sizeLive(stage); }); return; }
  if (pv.classList.contains('actual')) { stage.style.zoom = String(dpr); return; }
  const label = stage.previousElementSibling?.offsetHeight || 0;
  const fit = Math.min(1, (pv.clientWidth - 32) / r.width, (pv.clientHeight - 32 - label) / r.height);
  stage.style.zoom = String(Math.max(0.1, fit));
}

// The frame strip above the preview: for framed captures only. Captures framed before screens
// were kept show it switched off, with a note.
function showStrip(c) {
  const strip = $('#framestrip');
  strip.hidden = !framed(c);
  if (strip.hidden) return;
  strip.classList.toggle('off', !live(c));
  $('#fsFrame').value = c.frame;
  const bg = edit?.bg || c.framing?.bg || c.options?.frameBg || 'transparent';
  $$('input[name="fsBg"]').forEach((i) => { i.checked = i.value === bg; });
  stripClock(edit?.frame ?? c.frame, edit?.time ?? c.framing?.time ?? '9:41', edit?.date ?? c.framing?.date ?? 'Tue Jan 9');
  if (!live(c)) setStatus('This capture has no saved screens. Use Capture again to change its frame.');
}

// The strip's time and date fields: shown for frames with a clock, filled without moving the
// caret of a field being typed in.
function stripClock(kind, time, date) {
  $('#fsTimeField').hidden = !['phone', 'tablet'].includes(kind);
  $('#fsDateField').hidden = kind !== 'tablet';
  if ($('#fsTime').value !== time) $('#fsTime').value = time;
  if ($('#fsDate').value !== date) $('#fsDate').value = date;
}

// An empty time means the default, as on the server (clockText in lib/snap/options.js).
const clockOf = (t) => String(t ?? '').trim() || '9:41';
const same = (a, b) => a.frame === b.frame && a.bg === b.bg && clockOf(a.time) === clockOf(b.time) && String(a.date ?? '').trim() === String(b.date ?? '').trim();
const savedOf = (c) => ({ frame: c.frame, bg: c.framing.bg, time: c.framing.time ?? '9:41', date: c.framing.date ?? 'Tue Jan 9' });

function setStatus(text, kind = '') {
  const s = $('#fsStatus');
  s.className = `fs-status ${kind}`;
  s.replaceChildren(...(kind === 'saving' ? [el('span', { class: 'spinner', 'aria-hidden': 'true' })] : []), text);
}

// While a redraw is saving, the files on disk are the old ones: hold the buttons that use them.
function holdFileButtons(hold) {
  $$('#jactions .btn, #preview .partlabel .btn').forEach((b) => {
    const href = b.getAttribute('href') || '';
    if (href.includes('/files/') || href.includes('/zip') || b.textContent.trim() === 'Copy') b.classList.toggle('busy', hold);
  });
}

// Change the live capture's frame and/or background: redraw now, save a moment later.
function applyFrame(change) {
  const c = shown;
  if (!c || !live(c) || $('#job').hidden) return;
  const next = { ...edit, ...change };
  if (same(next, edit)) return;
  edit = next;
  $('#fsFrame').value = edit.frame;
  $$('input[name="fsBg"]').forEach((i) => { i.checked = i.value === edit.bg; });
  stripClock(edit.frame, edit.time, edit.date);
  $('#preview').replaceChildren();
  renderLive(c);
  setStatus('Not saved yet');
  holdFileButtons(true);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => save(c), 450);
}

// Redraw the saved images on the server with the frame and background on screen.
async function save(c) {
  if (saving) await saving.catch(() => {});
  if (shown !== c) return;
  const want = { ...edit };
  if (same(want, savedOf(c))) { setStatus('Saved', 'saved'); holdFileButtons(false); return; }
  setStatus('Saving…', 'saving');
  saving = api(`/api/captures/${encodeURIComponent(c.id)}/frame`, { ...json({ frame: want.frame, frameBg: want.bg, frameTime: want.time, frameDate: want.date }), method: 'PATCH' });
  try {
    const entry = await saving;
    Object.assign(c, entry);
    if (shown !== c) return;
    // Another change came in while this one saved: save that one too.
    if (!same(edit, savedOf(c))) { saveTimer = setTimeout(() => save(c), 0); return; }
    setStatus('Saved', 'saved');
    setMeta(pill('done', 'Saved'), c.options ? viewportLabel(c.options) : null, frameText(c), partsText(c), c.size ? fmtSize(c.size) : null);
    holdFileButtons(false);
    emit('captures-changed');
  } catch (err) {
    if (shown === c) { setStatus(err.message, 'error'); holdFileButtons(false); }
  } finally {
    saving = null;
  }
}

async function copyImage(name) {
  // Hand the clipboard a promise right away: Safari drops the click's permission if we await first.
  const png = (async () => {
    const blob = await (await fetch(fileUrl(name))).blob();
    if (blob.type === 'image/png') return blob;
    // Clipboards only take PNG, so convert JPEG captures.
    const bmp = await createImageBitmap(blob);
    const canvas = Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
    canvas.getContext('2d').drawImage(bmp, 0, 0);
    return new Promise((r) => canvas.toBlob(r, 'image/png'));
  })();
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    toast('The image is on the clipboard.');
  } catch {
    toast('The copy failed. The browser did not allow access to the clipboard.');
  }
}

// Open the captures folder, with `file` selected when given.
export async function reveal(file) {
  try { await api('/api/reveal', json({ file })); toast('Opened the folder.'); } catch (err) { toast(err.message); }
}

export function initResult() {
  $('#fsFrame').addEventListener('change', (e) => applyFrame({ frame: e.target.value }));
  $('#fsBgSeg').addEventListener('change', (e) => applyFrame({ bg: e.target.value }));
  $('#fsTime').addEventListener('input', (e) => applyFrame({ time: e.target.value }));
  $('#fsDate').addEventListener('input', (e) => applyFrame({ date: e.target.value }));
  $('#framestrip [data-now]').addEventListener('click', () => applyFrame(clockNow()));
  // The sidebar's Device frame and Background also change the framed capture on screen.
  on('sidebar-frame', ({ frame, frameBg, frameTime, frameDate }) => {
    if (!shown || !live(shown)) return;
    if (frame && frame !== 'none') applyFrame({ frame: frame === 'auto' ? autoFrame(undefined, shown.framing.w) : frame });
    if (frameBg) applyFrame({ bg: frameBg });
    if (frameTime !== undefined) applyFrame({ time: frameTime });
    if (frameDate !== undefined) applyFrame({ date: frameDate });
  });
  window.addEventListener('resize', () => { const st = $('#preview .stack'); if (st) $$('.livestage', st).forEach(sizeLive); });
  $('#fpEvery').addEventListener('change', frameHint);
  $('#fpClose').addEventListener('click', closeFramePanel);
  $('#fpGo').addEventListener('click', () => {
    if (!framing) return;
    const frameBg = $('input[name="fpBg"]:checked')?.value || 'transparent';
    // The clock comes from the sidebar; it can change afterwards in the live strip.
    const side = (n) => document.querySelector(`#opts [name="${n}"]`)?.value;
    emit('frame', framing, { frame: $('#fpFrame').value, frameBg, every: $('#fpEvery').checked, frameTime: side('frameTime'), frameDate: side('frameDate') });
  });
  $('#zoom').addEventListener('click', (e) => { const z = e.target.dataset?.z; if (z) setZoom(z); });
  $('#reveal').addEventListener('click', () => reveal());
}
