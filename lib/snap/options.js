// Capture options: defaults, validation, and the URL and device helpers they need.

import path from 'node:path';
import { devices } from 'playwright';
import { FRAMES, FRAME_BACKGROUNDS, FRAME_TIME, FRAME_DATE } from './frames.js';

export const DEFAULTS = {
  url: undefined,
  out: undefined,
  format: undefined,
  quality: 85,
  pdfPaged: false,
  width: 1440,
  height: 900,
  scale: 1,
  device: undefined,
  dark: false,
  userAgent: undefined,
  browser: 'chromium',
  cookies: 'reject',
  sticky: 'once',
  scroll: true,
  maxHeight: 20000,
  maxScrolls: 60,
  hide: [],
  wait: 500,
  waitFor: undefined,
  timeout: 45000,
  headed: false,
  split: 'none',
  sliceHeight: undefined,
  parts: [],
  exactCuts: false,
  frame: 'none',
  frameBg: 'transparent',
  frameTime: '9:41', // the status bar clock on phone and tablet frames
  frameDate: 'Tue Jan 9', // the date next to it on tablet frames ('' hides it)
  // Framed captures: also save each unframed screen under <out dir>/.frames/<name>/, so the
  // frame and background can change later without loading the site (the UI server sets this).
  keepScreens: false,
};

export const SPLITS = ['none', 'screen', 'sections', 'height', 'elements'];
export const BROWSER_NAMES = ['chromium', 'firefox', 'webkit'];
const EXT_FORMAT = { '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.pdf': 'pdf' };

export function listDevices() {
  return Object.keys(devices).filter((d) => !d.endsWith(' landscape'));
}

export function findDevice(name) {
  if (!name) return undefined;
  const key = devices[name] ? name : Object.keys(devices).find((d) => d.toLowerCase() === name.toLowerCase());
  return key && devices[key];
}

export function hostOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'file:') return path.basename(decodeURIComponent(u.pathname)).replace(/\.[^.]*$/, '') || 'page';
    return u.hostname.replace(/^www\./, '') || 'page';
  } catch { return 'page'; }
}

// "localhost:3000" and "example.com:8080/x" are host:port, not a scheme.
export const hasScheme = (u) => /^[a-z][a-z0-9+.-]*:/i.test(u) && !/^[^/:]+:[0-9]+([/?#]|$)/.test(u);

// The status bar clock and date of a frame: what was given, trimmed, or the defaults. The date may
// be '' (no date). Throws when either is too long to fit the status bar.
export function clockText(time, date) {
  const t = time === undefined || time === null || String(time).trim() === '' ? FRAME_TIME : String(time).trim();
  const d = date === undefined || date === null ? FRAME_DATE : String(date).trim();
  if (t.length > 12) throw new Error('The frame time must be 12 characters or fewer, for example 9:41.');
  if (d.length > 24) throw new Error('The frame date must be 24 characters or fewer, for example Tue Jan 9.');
  return { time: t, date: d };
}

// Fill in defaults and validate. Throws an Error with a user-facing message on bad input.
export function normalize(input) {
  const o = { ...DEFAULTS };
  for (const [k, v] of Object.entries(input)) if (v !== undefined && v !== '') o[k] = v;

  if (!o.url) throw new Error('The URL is missing.');
  o.url = String(o.url).trim();
  // Local dev servers rarely have TLS, so bare localhost gets http.
  if (!hasScheme(o.url)) o.url = `${/^(localhost|127\.|\[::1\])/i.test(o.url) ? 'http' : 'https'}://${o.url}`;
  let proto;
  try { proto = new URL(o.url).protocol; } catch { throw new Error(`The URL "${o.url}" is not valid.`); }
  if (!['http:', 'https:', 'file:'].includes(proto)) throw new Error(`The URL scheme "${proto}" is not supported. Use http, https, or file.`);

  for (const k of ['quality', 'width', 'height', 'scale', 'maxHeight', 'maxScrolls', 'wait', 'timeout']) {
    const n = Number(o[k]);
    if (!Number.isFinite(n) || n < 0) throw new Error(`The value of "${k}" must be a number that is 0 or more.`);
    o[k] = n;
  }
  o.quality = Math.min(100, o.quality);
  if (!o.scale) o.scale = 1;
  if (o.width < 100 || o.height < 100) throw new Error('The viewport must be 100 × 100 px or larger.');

  // Format comes from format, else the out extension, else png.
  o.format = (o.format ? String(o.format).toLowerCase().replace('jpg', 'jpeg') : undefined)
    ?? EXT_FORMAT[path.extname(o.out ?? '').toLowerCase()] ?? 'png';
  if (!['png', 'jpeg', 'pdf'].includes(o.format)) throw new Error(`The format "${o.format}" is not supported. Use png, jpeg, or pdf.`);
  o.out ??= `${hostOf(o.url)}.${o.format === 'jpeg' ? 'jpg' : o.format}`;

  if (!['reject', 'accept', 'hide', 'off'].includes(o.cookies)) throw new Error('The cookies value must be reject, accept, hide, or off.');
  if (!['once', 'hide', 'keep'].includes(o.sticky)) throw new Error('The sticky value must be once, hide, or keep.');
  if (!BROWSER_NAMES.includes(o.browser)) throw new Error('The browser must be chromium, firefox, or webkit.');
  if (o.format === 'pdf' && o.browser !== 'chromium') throw new Error('PDF output needs the chromium browser.');
  if (o.device && !findDevice(o.device)) throw new Error(`The device "${o.device}" is not known. Run "pagesnap --list-devices" to see the device names.`);
  o.hide = [].concat(o.hide ?? []).map((s) => String(s).trim()).filter(Boolean);

  // Splitting: a slice height or element selectors on their own pick the split mode.
  o.parts = [].concat(o.parts ?? []).map((s) => String(s).trim()).filter(Boolean);
  o.split = String(o.split || 'none').toLowerCase();
  if (o.split === 'none' && o.sliceHeight !== undefined) o.split = 'height';
  if (o.split === 'none' && o.parts.length) o.split = 'elements';
  if (!SPLITS.includes(o.split)) throw new Error(`The split value "${o.split}" is not supported. Use screen, sections, height, or elements.`);
  if (o.split !== 'none' && o.format === 'pdf') throw new Error('PDF output cannot be split into images. Use PNG or JPEG, or use A4 pages for PDF.');
  if (o.split === 'height') {
    const h = String(o.sliceHeight ?? '').toLowerCase();
    if (h !== 'a4' && h !== 'letter') {
      const n = Number(h);
      if (!h || !Number.isFinite(n) || n < 100) throw new Error('The slice height must be a number of 100 px or more, or "a4" or "letter".');
      o.sliceHeight = n;
    } else {
      o.sliceHeight = h;
    }
  }
  if (o.split === 'elements' && !o.parts.length) throw new Error('Splitting by elements needs one or more CSS selectors.');
  o.exactCuts = o.exactCuts === true || o.exactCuts === 'true';

  // Device frames show what a screen shows: the first screen, or every screen with the Screens split.
  o.frame = String(o.frame || 'none').toLowerCase();
  o.frameBg = String(o.frameBg || 'transparent').toLowerCase();
  if (!FRAMES.includes(o.frame)) throw new Error(`The frame "${o.frame}" is not supported. Use auto, phone, tablet, laptop, or browser.`);
  if (!FRAME_BACKGROUNDS.includes(o.frameBg)) throw new Error(`The frame background "${o.frameBg}" is not supported. Use transparent, light, dark, or gradient.`);
  if (o.frame !== 'none') {
    if (o.format === 'pdf') throw new Error('PDF output cannot have a device frame. Use PNG or JPEG.');
    if (!['none', 'screen'].includes(o.split)) throw new Error('A device frame works with one screen or with the Screens split. Remove the split, or use --split screen.');
    // JPEG has no transparency.
    if (o.format === 'jpeg' && o.frameBg === 'transparent') o.frameBg = 'light';
  }
  ({ time: o.frameTime, date: o.frameDate } = clockText(input.frameTime, input.frameDate));
  return o;
}
