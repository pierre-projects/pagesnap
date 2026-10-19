// Running a capture: send the request, follow its progress over SSE (steps, scroll bar, log),
// and end in the result view, an error notice, or "cancelled".

import { $, el, btn } from './dom.js';
import { api, json } from './api.js';
import { fmtPx, viewportLabel } from './format.js';
import { toast } from './toast.js';
import { showTab } from './tabs.js';
import { on, emit } from './events.js';
import { writeForm, formFromOptions, buildRequest, saveForm, closeOptions } from './options.js';
import { urlInput, withScheme, checkUrl, urlError } from './url.js';
import { showJobView, showEmpty, resetJobView, setHeader, setMeta, setPill, pill, notice } from './view.js';
import { showCapture } from './result.js';

const STEP_INFO = {
  load: ['Load', 'Open the page'],
  cookies: ['Clean up', 'Close cookie banners'],
  scroll: ['Scroll', 'Load lazy images'],
  capture: ['Save', 'Write the file'],
};
const STEP_ACTIVE = { load: 'Loading', cookies: 'Cleaning up', scroll: 'Scrolling', capture: 'Saving' };
let STEPS = ['load', 'cookies', 'scroll', 'capture'];

// The server's step list (from /api/config), in case it ever changes.
export function setSteps(steps) { if (Array.isArray(steps)) STEPS = steps; }

let current = null; // the job shown in the Capture tab
const goBtn = $('#go');

function setBusy(busy) {
  goBtn.disabled = busy;
  goBtn.replaceChildren(...(busy ? [el('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Capturing'] : ['Capture']));
  // While a capture runs, "Cancel" is the way out; "New capture" comes back when it ends.
  $('#jback').hidden = busy;
}

// Back to the start screen (URL prompt, examples, recent captures). A running capture stays on
// screen: leave it with Cancel.
export function goHome() {
  showTab('result');
  if (current?.running) return;
  current = null;
  resetJobView();
  showEmpty();
  setTitle();
  urlInput.focus();
  urlInput.select();
}

// The tab title shows progress, and the result while the tab is in the background.
function setTitle(state) {
  const base = 'pagesnap';
  document.title = state === 'running' ? `Capturing… · ${base}` : state === 'done' && document.hidden ? `✓ Ready · ${base}`
    : state === 'error' && document.hidden ? `✕ Failed · ${base}` : base;
}

// state: { [step]: active | done | failed }
function renderSteps(state = {}) {
  const box = $('#steps');
  box.hidden = false;
  box.replaceChildren(...STEPS.map((s, i) => {
    const st = state[s] || 'todo';
    const [name, sub] = STEP_INFO[s] || [s, ''];
    const mark = st === 'done' ? '✓' : st === 'failed' ? '!' : st === 'active' ? '' : String(i + 1);
    return el('div', { class: `step ${st === 'todo' ? '' : st}`, 'data-step': s },
      el('div', { class: 'n' }, el('i', {}, mark), name),
      el('div', { class: 's' }, sub),
      el('div', { class: 'bar' }));
  }));
}

function logLine(text, cls) {
  const log = $('#log');
  $('#logwrap').hidden = false;
  const secs = current ? ((Date.now() - current.started) / 1000).toFixed(1).padStart(5) : '';
  log.append(el('div', { class: cls || '' }, el('span', { class: 't' }, `${secs}s`), text));
  log.scrollTop = log.scrollHeight;
  $('#logsum').textContent = `Details (${log.children.length} ${log.children.length === 1 ? 'line' : 'lines'})`;
}

// Start a capture of the URL field. `override` is a saved request to repeat ("Try again").
export async function capture(e, override) {
  e?.preventDefault();
  if (current?.running) return;
  const problem = checkUrl(urlInput.value);
  if (problem) {
    urlError(problem);
    urlInput.focus();
    return;
  }
  let req;
  try { req = override ? { ...override, url: urlInput.value.trim() } : buildRequest(urlInput.value.trim()); }
  catch (err) { toast(err.message); return; }
  saveForm();
  showTab('result');
  showJobView();
  resetJobView();
  closeOptions();

  const job = current = { started: Date.now(), running: true, steps: {}, req };
  setBusy(true);
  setTitle('running');
  setHeader(withScheme(req.url));
  renderSteps();
  const elapsed = el('span', {}, '0 s');
  setMeta(pill('running', 'Starting'), elapsed, viewportLabel(req), req.format.toUpperCase());
  job.timer = setInterval(() => { elapsed.textContent = `${Math.floor((Date.now() - job.started) / 1000)} s`; }, 500);
  $('#jactions').append(btn('Cancel', 'x', { onclick: () => cancelJob(job) }));

  try {
    ({ id: job.id } = await api('/api/snap', json(req)));
  } catch (err) {
    return fail(job, err.message);
  }
  if (current !== job) return;
  follow(job);
}

// Put saved capture `c` in a device frame on the server ("Frame this"). The site does not load
// again, so there are no load/scroll steps and nothing to cancel: it takes a second or two.
async function runFrame(c, { frame, frameBg, every, frameTime, frameDate }) {
  if (current?.running) { toast('Wait for the current capture to finish.'); return; }
  showTab('result');
  showJobView();
  resetJobView();
  const job = current = { started: Date.now(), running: true, steps: {}, retry: () => runFrame(c, { frame, frameBg, every, frameTime, frameDate }) };
  setBusy(true);
  setTitle('running');
  setHeader(c.url || c.id);
  const elapsed = el('span', {}, '0 s');
  setMeta(pill('running', 'Framing'), elapsed, every ? 'Every screen' : 'First screen');
  job.timer = setInterval(() => { elapsed.textContent = `${Math.floor((Date.now() - job.started) / 1000)} s`; }, 500);
  try {
    ({ id: job.id } = await api(`/api/captures/${encodeURIComponent(c.id)}/frame`, json({ frame, frameBg, every, frameTime, frameDate })));
  } catch (err) {
    return fail(job, err.message);
  }
  if (current !== job) return;
  follow(job);
}

// Listen to the job's server-sent events until it is done, fails, or is cancelled.
function follow(job) {
  const es = job.es = new EventSource(`/api/jobs/${job.id}/events`);
  es.addEventListener('queued', (ev) => {
    const { ahead } = JSON.parse(ev.data);
    setPill('queued', ahead ? `Waiting · ${ahead} ahead` : 'Starting');
  });
  es.addEventListener('step', (ev) => {
    const step = JSON.parse(ev.data);
    for (const s of STEPS) {
      if (s === step) break;
      job.steps[s] = 'done';
    }
    job.steps[step] = 'active';
    job.active = step;
    renderSteps(job.steps);
    setPill('running', STEP_ACTIVE[step] || 'Working');
  });
  es.addEventListener('progress', (ev) => {
    const { y, height } = JSON.parse(ev.data);
    const bar = $('.step[data-step="scroll"] .bar');
    if (bar) bar.style.width = `${Math.min(100, (y / height) * 100)}%`;
    const sub = $('.step[data-step="scroll"] .s');
    if (sub) sub.textContent = `${fmtPx(y)} of ${fmtPx(height)}`;
  });
  es.addEventListener('log', (ev) => {
    const msg = JSON.parse(ev.data);
    logLine(msg, msg.startsWith('Warning') ? 'w' : '');
  });
  es.addEventListener('done', (ev) => { es.close(); if (current === job) finish(job, JSON.parse(ev.data)); });
  es.addEventListener('error', (ev) => {
    es.close();
    if (current !== job || !job.running) return;
    if (ev.data) {
      const { message, cancelled } = JSON.parse(ev.data);
      if (cancelled) cancelledView(job); else fail(job, message);
    } else {
      fail(job, 'The connection to the pagesnap server stopped. Make sure that the server is running.');
    }
  });
}

async function cancelJob(job) {
  if (!job.id) return;
  try { await api(`/api/jobs/${job.id}/cancel`, { method: 'POST' }); }
  catch (err) { toast(err.message); }
}

function endJob(job) {
  job.running = false;
  clearInterval(job.timer);
  setBusy(false);
  $('#jactions').replaceChildren();
}

// "Try again" repeats the last job: a capture, or a "Frame this" (job.retry).
const retryButton = () => btn('Try again', 'redo', { onclick: () => (current?.retry ? current.retry() : capture(null, current?.req)) });

function cancelledView(job) {
  endJob(job);
  setTitle();
  if (job.active) job.steps[job.active] = 'failed';
  renderSteps(job.steps);
  setPill('error', 'Cancelled');
  notice('warn', 'The capture was cancelled.', 'No file was saved.', retryButton());
  logLine('The capture was cancelled.', 'e');
}

function fail(job, message) {
  endJob(job);
  setTitle('error');
  if (job.active) job.steps[job.active] = 'failed';
  renderSteps(job.steps);
  setPill('error', 'Failed');
  // Split "The page did not load. The server name was not found. Check the URL." into a title and detail.
  const m = message.match(/^(.+?\.)\s+(.+)$/);
  notice('error', m ? m[1] : message, m ? m[2] : '', retryButton());
  logLine(message, 'e');
}

function finish(job, entry) {
  endJob(job);
  setTitle('done');
  // Every step is done, so the step row only pushes the preview down. The "Saved" label says it all.
  $('#steps').hidden = true;
  showCapture(entry, { fresh: true });
  emit('captures-changed');
}

// Put a saved capture's URL and options back in the form, and run it.
function recapture(c) {
  urlInput.value = c.url;
  if (c.options) writeForm(formFromOptions(c.options));
  saveForm();
  capture(null);
}

export function initCapture() {
  $('#urlform').addEventListener('submit', capture);
  // The example links on the empty Capture tab.
  $('#examples').addEventListener('click', (e) => {
    const u = e.target.closest('[data-url]')?.dataset.url;
    if (!u) return;
    urlInput.value = u;
    capture(null);
  });
  on('recapture', recapture);
  on('frame', runFrame);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !current?.running) setTitle(); });

  // Ways back to the start screen without reloading: "← New capture", Esc, and the logo.
  $('#jback').addEventListener('click', goHome);
  $('#home').addEventListener('click', (e) => { e.preventDefault(); goHome(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    // Focus usually stays in the URL field after Enter, so Esc works there too. Not in the
    // sidebar's fields, where Esc may close a device list.
    const a = document.activeElement;
    const typing = a !== urlInput && /^(INPUT|TEXTAREA|SELECT)$/.test(a?.tagName);
    const onJob = !$('#job').hidden && !$('#result').hidden;
    if (!typing && onJob) goHome();
  });
}
