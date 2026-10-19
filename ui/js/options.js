// The options sidebar: reading and writing the form, the hints that follow it, and turning it
// into a capture request for the server.

import { $, $$, el } from './dom.js';
import * as store from './store.js';
import { toast } from './toast.js';
import { emit } from './events.js';
import { clockNow } from './format.js';

const opts = $('#opts');

export const PRESETS = { desktop: [1440, 900], tablet: [768, 1024] };

const FIELDS = ['format', 'quality', 'pdfPaged', 'split', 'sliceHeight', 'parts', 'vp', 'device', 'width', 'height', 'scale', 'dark',
  'frame', 'frameBg', 'frameTime', 'frameDate', 'cookies', 'sticky', 'scroll', 'maxHeight', 'wait', 'waitFor', 'hide', 'timeoutS'];
const FRAME_NAME = { phone: 'Phone', tablet: 'Tablet', laptop: 'Laptop', browser: 'Browser window' };
// Splits that work inside a device frame: one screen, or every screen.
const FRAME_SPLITS = ['none', 'screen'];
// Fields under "Page handling"; the section header counts how many differ from the defaults.
const ADVANCED = ['cookies', 'sticky', 'scroll', 'maxHeight', 'wait', 'waitFor', 'hide', 'timeoutS'];

const FORMAT_HINT = {
  png: 'PNG gives the sharpest image.',
  jpeg: 'JPEG gives a smaller file. Use it for long pages with photos.',
  pdf: 'PDF keeps text that you can select and search.',
};
const SPLIT_HINT = {
  none: 'pagesnap saves the full page as one image.',
  screen: 'Each image is at most one screen high. The cuts go in the gaps between content, so no text is cut in half.',
  sections: 'Each image is one section of the page, for example the header, a feature block, or the footer.',
  height: 'Each image is at most the height that you set. The cuts go in the gaps between content.',
  elements: 'Each element that matches a selector becomes one image.',
};

// The form as it is in the HTML, before anything saved is restored. "Reset all options" goes back here.
let initial = {};

export function readForm() {
  const v = {};
  for (const name of FIELDS) {
    const inputs = $$(`[name="${name}"]`, opts);
    if (!inputs.length) continue;
    const first = inputs[0];
    if (first.type === 'radio') v[name] = inputs.find((i) => i.checked)?.value;
    else if (first.type === 'checkbox') v[name] = first.checked;
    else v[name] = first.value;
  }
  return v;
}

export function writeForm(v) {
  for (const [name, val] of Object.entries(v)) {
    const inputs = $$(`[name="${name}"]`, opts);
    if (!inputs.length || val === undefined) continue;
    if (inputs[0].type === 'radio') inputs.forEach((i) => { i.checked = i.value === String(val); });
    else if (inputs[0].type === 'checkbox') inputs[0].checked = !!val;
    else inputs[0].value = val;
  }
  sync();
}

// Map saved server options (from History) back onto the form.
export function formFromOptions(o) {
  const v = {
    format: o.format, quality: o.quality, pdfPaged: o.pdfPaged, dark: o.dark, cookies: o.cookies, sticky: o.sticky,
    scroll: o.scroll, maxHeight: o.maxHeight, wait: o.wait, waitFor: o.waitFor || '', hide: (o.hide || []).join('\n'),
    timeoutS: Math.round((o.timeout || 45000) / 1000), scale: o.scale,
    split: o.split || 'none', sliceHeight: o.sliceHeight ?? '1200', parts: (o.parts || []).join('\n'),
    frame: o.frame || 'none', frameBg: o.frameBg || 'transparent', frameTime: o.frameTime ?? '9:41', frameDate: o.frameDate ?? 'Tue Jan 9',
  };
  if (o.device) Object.assign(v, { vp: 'phone', device: o.device });
  else {
    const preset = Object.entries(PRESETS).find(([, [w, h]]) => w === o.width && h === o.height)?.[0];
    Object.assign(v, preset ? { vp: preset } : { vp: 'custom', width: o.width, height: o.height });
  }
  return v;
}

// The frame "Auto" picks for the viewport. Mirrors autoFrame() in lib/snap/frames.js; the device
// list only gives names here, so tablets are spotted by name.
function autoFrameFor(v) {
  if (v.vp === 'phone') return /ipad|tab|kindle|nexus (7|10)/i.test(v.device) ? 'tablet' : 'phone';
  const w = v.vp === 'custom' ? Number(v.width) : PRESETS[v.vp][0];
  return w < 600 ? 'phone' : w < 1100 ? 'tablet' : 'laptop';
}

// Select a radio button by value without firing change events.
function setRadio(name, value) {
  $$(`input[name="${name}"]`, opts).forEach((i) => { i.checked = i.value === value; });
}

// Show and hide the fields that depend on other fields, and update hints and summaries.
function sync() {
  let v = readForm();

  // A device frame holds one screen or every screen, so the other splits are switched off.
  const framed = v.format !== 'pdf' && v.frame !== 'none';
  for (const r of $$('input[name="split"]', opts)) {
    const off = framed && !FRAME_SPLITS.includes(r.value);
    r.disabled = off;
    r.closest('label').classList.toggle('disabled', off);
  }
  if (framed && !FRAME_SPLITS.includes(v.split)) { setRadio('split', 'none'); v = readForm(); }
  const kind = v.frame === 'auto' ? autoFrameFor(v) : v.frame;
  $('#frameGroup').hidden = v.format === 'pdf';
  $('#frameBgField').hidden = !framed;
  // Only phones and tablets have a status bar clock; only tablets show the date.
  $('#clockField').hidden = !framed || !['phone', 'tablet'].includes(kind);
  $('#dateField').hidden = kind !== 'tablet';
  $('#frameout').textContent = framed ? FRAME_NAME[kind] : '';
  $('#frameHint').textContent = !framed ? 'Saves the image without a frame.'
    : v.split === 'screen' ? `Each screen of the page gets its own ${FRAME_NAME[kind].toLowerCase()} frame, as if you scroll on the device.`
    : `Saves the first screen inside a ${FRAME_NAME[kind].toLowerCase()} frame.`;

  $('#qualityField').hidden = v.format !== 'jpeg';
  $('#pagedField').hidden = v.format !== 'pdf';
  $('#formatHint').textContent = FORMAT_HINT[v.format];
  $('#qout').textContent = v.quality;
  // PDF has its own A4 pages option, so the image split does not apply.
  const split = v.format === 'pdf' ? 'none' : v.split;
  $('#splitGroup').hidden = v.format === 'pdf';
  $('#sliceField').hidden = split !== 'height';
  $('#partsField').hidden = split !== 'elements';
  $('#splitHint').textContent = framed
    ? (split === 'screen' ? 'Every screen of the page goes in its own frame.' : 'Only the first screen goes in the frame.')
    : SPLIT_HINT[split];
  const slice = String(v.sliceHeight).trim().toLowerCase();
  $$('[data-slice]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.slice === slice)));
  $('#splitout').textContent = split === 'height' ? (slice === 'a4' ? 'A4' : slice === 'letter' ? 'Letter' : `${slice} px`) : '';
  $('#deviceField').hidden = v.vp !== 'phone';
  $('#customField').hidden = v.vp !== 'custom';
  $('#scaleField').hidden = v.vp === 'phone';
  const size = v.vp === 'phone' ? (v.device || 'Select a device')
    : v.vp === 'custom' ? `${v.width || '?'} × ${v.height || '?'}` : PRESETS[v.vp].join(' × ');
  $('#vpout').textContent = size;
  const changed = ADVANCED.filter((k) => String(v[k]) !== String(initial[k])).length;
  $('#advnote').textContent = changed ? `${changed} changed` : '';
  const SPLIT_NAME = { screen: 'Screens', sections: 'Sections', height: 'Height', elements: 'Elements' };
  const splitName = split === 'none' ? '' : ` · ${SPLIT_NAME[split]}`;
  const frameName = framed ? ` · ${FRAME_NAME[kind]} frame` : '';
  $('#optsummary').textContent = `${v.format.toUpperCase()} · ${v.vp === 'phone' ? v.device : size}${splitName}${frameName}`;
}

// Remember the form and the URL field for the next visit.
export function saveForm() {
  store.patch({ form: readForm(), url: $('#url').value });
}

// The form as a POST /api/snap body. Throws an Error with a message for the person.
export function buildRequest(url) {
  const v = readForm();
  const req = {
    url, format: v.format, dark: v.dark, cookies: v.cookies, sticky: v.sticky, scroll: v.scroll,
    maxHeight: v.maxHeight, wait: v.wait, waitFor: v.waitFor.trim() || undefined,
    hide: v.hide.split('\n').map((s) => s.trim()).filter(Boolean),
    timeout: Math.round(Number(v.timeoutS || 45) * 1000),
  };
  if (v.format === 'jpeg') req.quality = Number(v.quality);
  if (v.format === 'pdf') req.pdfPaged = v.pdfPaged;
  if (v.format !== 'pdf' && v.frame !== 'none') {
    req.frame = v.frame;
    req.frameBg = v.frameBg;
    req.frameTime = v.frameTime;
    req.frameDate = v.frameDate;
  }
  if (v.format !== 'pdf' && v.split !== 'none') {
    req.split = v.split;
    if (v.split === 'height') {
      const h = String(v.sliceHeight).trim().toLowerCase();
      if (h !== 'a4' && h !== 'letter' && !(Number(h) >= 100)) throw new Error('Type a slice height of 100 px or more, or use A4 or Letter.');
      req.sliceHeight = h;
    }
    if (v.split === 'elements') {
      req.parts = v.parts.split('\n').map((s) => s.trim()).filter(Boolean);
      if (!req.parts.length) throw new Error('Type one or more CSS selectors for the Elements split.');
    }
  }
  if (v.vp === 'phone') {
    if (!v.device.trim()) throw new Error('Select a device for the Phone viewport.');
    req.device = v.device.trim();
  } else {
    const [w, h] = v.vp === 'custom' ? [v.width, v.height] : PRESETS[v.vp];
    req.width = Number(w);
    req.height = Number(h);
    req.scale = Number(v.scale);
  }
  return req;
}

// Fill the device suggestions: common phones first, then the rest.
export function setDevices(devices) {
  const common = ['iPhone 15 Pro', 'iPhone 15 Pro Max', 'iPhone SE', 'Pixel 7', 'Galaxy S9+', 'iPad Mini', 'iPad Pro 11'];
  const ordered = [...common.filter((d) => devices.includes(d)), ...devices.filter((d) => !common.includes(d))];
  $('#devices').replaceChildren(...ordered.map((d) => el('option', { value: d })));
}

// Close the sidebar on small screens (after a capture starts).
export const closeOptions = () => $('#aside').classList.remove('open');

export function initOptions() {
  initial = readForm();
  const saved = store.load();
  if (saved.form) writeForm(saved.form); else sync();

  opts.addEventListener('input', (e) => {
    sync();
    saveForm();
    // Typing a time or date updates a framed capture on screen as you type (result.js).
    if (e.target.name === 'frameTime') emit('sidebar-frame', { frameTime: e.target.value });
    if (e.target.name === 'frameDate') emit('sidebar-frame', { frameDate: e.target.value });
  });
  opts.addEventListener('change', (e) => {
    sync();
    saveForm();
    // A framed capture on screen follows the sidebar's frame and background (result.js).
    if (e.target.name === 'frame') emit('sidebar-frame', { frame: e.target.value });
    if (e.target.name === 'frameBg') emit('sidebar-frame', { frameBg: e.target.value });
  });
  // A4 / Letter quick picks next to the slice height field, and "Now" next to the frame time.
  opts.addEventListener('click', (e) => {
    if (e.target.closest('[data-now]')) {
      const { time, date } = clockNow();
      opts.elements.frameTime.value = time;
      opts.elements.frameDate.value = date;
      sync();
      saveForm();
      emit('sidebar-frame', { frameTime: time, frameDate: date });
      return;
    }
    const b = e.target.closest('[data-slice]');
    if (!b) return;
    opts.elements.sliceHeight.value = b.dataset.slice;
    sync();
    saveForm();
  });
  $('#reset').addEventListener('click', () => { writeForm(initial); saveForm(); toast('All options are reset.'); });
  // On small screens the options fold into one line.
  $('#opttoggle').addEventListener('click', () => {
    const open = $('#aside').classList.toggle('open');
    $('#opttoggle').setAttribute('aria-expanded', String(open));
  });
}
