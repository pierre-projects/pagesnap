// Framing a capture that already exists, without loading the site again. The capture's images are
// stacked top to bottom and seen through the device's screen, one screen at a time. The status bar
// color comes from the image's pixels instead of the page's DOM.
//
// Compared to a framed capture (captureFramed), the only difference shows with every screen of a
// page that has a fixed header: the full-page image has that header once, at the top, so later
// screens show the page without it.

import path from 'node:path';
import fs from 'node:fs/promises';
import { launch } from './browser.js';
import { autoFrame, FRAMES, FRAME_BACKGROUNDS, FRAME_NAMES } from './frames.js';
import { renderFrameTo, keepScreen, frameResult } from './capture.js';
import { findDevice, hostOf, clockText } from './options.js';

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

// Load the parts into canvases (kept on window for sampling) and return their pixel sizes.
// Runs in the sampling page.
async function loadPartsInPage(urls) {
  window.__parts = [];
  for (const url of urls) {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = Object.assign(document.createElement('canvas'), { width: img.naturalWidth, height: img.naturalHeight });
    canvas.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0);
    window.__parts.push(canvas);
  }
  return window.__parts.map((c) => ({ width: c.width, height: c.height }));
}

// The color of the top pixel row of the screen that starts at device pixel row `row`, averaged
// across the width, and whether text on it should be light. Runs in the sampling page.
function sampleTopInPage(row) {
  let y = row;
  let canvas = window.__parts[0];
  for (const c of window.__parts) {
    if (y < c.height) { canvas = c; break; }
    y -= c.height;
  }
  y = Math.max(0, Math.min(canvas.height - 1, y + 1));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let r = 0; let g = 0; let b = 0;
  const xs = [0.1, 0.3, 0.5, 0.7, 0.9];
  for (const fx of xs) {
    const [pr, pg, pb] = ctx.getImageData(Math.floor(canvas.width * fx), y, 1, 1).data;
    r += pr; g += pg; b += pb;
  }
  [r, g, b] = [r, g, b].map((v) => Math.round(v / xs.length));
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return { color: `rgb(${r}, ${g}, ${b})`, dark: lum < 0.55 };
}

// Frame the capture made of `files` (absolute paths, top to bottom).
//   viewport  { width?, height? } in CSS px. A missing width comes from the image and `dpr`.
//   dpr       pixel density of the images. Missing: image width ÷ viewport width, else 1.
//   device    a device name; sets the viewport when it is not given, and helps "auto".
//   url       shown in the address bar.
//   frame     auto | phone | tablet | laptop | browser.  frameBg: transparent | light | dark | gradient.
//   every     true: every screen, each in a frame. false: the first screen only.
//   out       the output file; with `every`, parts are named out-01, out-02, ...
// Returns the same shape as snap(): { files, parts, width, height, dpr, frame, split, warnings }.
export async function reframe(input, { onLog = () => {} } = {}) {
  const log = (msg) => onLog(msg);
  const files = [].concat(input.files ?? []);
  if (!files.length) throw new Error('There is no image to frame.');
  for (const f of files) {
    if (!MIME[path.extname(f).toLowerCase()]) throw new Error(`"${path.basename(f)}" is not a PNG or JPEG image.`);
  }
  const frame = String(input.frame || 'auto').toLowerCase();
  const bgIn = String(input.frameBg || 'transparent').toLowerCase();
  if (frame === 'none' || !FRAMES.includes(frame)) throw new Error(`The frame "${frame}" is not supported. Use auto, phone, tablet, laptop, or browser.`);
  if (!FRAME_BACKGROUNDS.includes(bgIn)) throw new Error(`The frame background "${bgIn}" is not supported. Use transparent, light, dark, or gradient.`);
  if (!input.out) throw new Error('The output file is missing.');
  const clock = clockText(input.frameTime, input.frameDate);

  const device = input.device ? findDevice(input.device) : undefined;
  if (input.device && !device) throw new Error(`The device "${input.device}" is not known. Run "pagesnap --list-devices" to see the device names.`);
  const urls = await Promise.all(files.map(async (f) => {
    const data = await fs.readFile(f).catch(() => { throw new Error(`The file "${path.basename(f)}" was not found.`); });
    return `data:${MIME[path.extname(f).toLowerCase()]};base64,${data.toString('base64')}`;
  }));

  const ext = path.extname(input.out).toLowerCase();
  // JPEG has no transparency.
  const bg = (ext === '.jpg' || ext === '.jpeg') && bgIn === 'transparent' ? 'light' : bgIn;

  log('Loading the captured image.');
  const browser = await launch({ browser: 'chromium', headed: false }, log);
  try {
    const sampler = await (await browser.newContext()).newPage();
    const sizes = await sampler.evaluate(loadPartsInPage, urls);
    const imgW = sizes[0].width;

    let vw = Number(input.viewport?.width) || device?.viewport.width || 0;
    let dpr = Number(input.dpr) || device?.deviceScaleFactor || 0;
    if (!dpr) dpr = vw ? Math.round((imgW / vw) * 100) / 100 : 1;
    if (!vw) vw = Math.round(imgW / dpr);
    const vh = Number(input.viewport?.height) || device?.viewport.height || 900;
    const totalRows = sizes.reduce((s, p) => s + p.height, 0);
    const pageH = totalRows / dpr;
    const kind = frame === 'auto' ? autoFrame(device, vw) : frame;

    const ys = [0];
    if (input.every) {
      for (let y = vh; y < pageH; y += vh) ys.push(Math.max(0, Math.min(y, pageH - vh)));
      while (ys.length > 1 && ys[ys.length - 1] === ys[ys.length - 2]) ys.pop();
    }

    const host = input.url ? hostOf(input.url) : path.basename(files[0]).replace(/(-\d{2,3})?(-[a-z0-9-]+)?\.[^.]+$/i, '');
    const ctx = await browser.newContext({ deviceScaleFactor: dpr, viewport: { width: 1200, height: 900 } });
    const page = await ctx.newPage();
    const stem = input.out.slice(0, input.out.length - path.extname(input.out).length);
    const single = ys.length === 1;
    const parts = [];
    await fs.mkdir(path.dirname(path.resolve(input.out)), { recursive: true });

    for (const [i, y] of ys.entries()) {
      const top = await sampler.evaluate(sampleTopInPage, Math.round(y * dpr));
      const out = single ? input.out : `${stem}-${String(i + 1).padStart(ys.length > 99 ? 3 : 2, '0')}${path.extname(input.out)}`;
      await renderFrameTo(page, out, kind, {
        parts: urls, offset: y, w: vw, h: vh, host, top, dark: !!input.dark || top.dark, bg, ...clock,
      });
      // The unframed screen, for later redraws: the screen area of the frame just drawn.
      const raw = input.keepScreens ? await keepScreen(input.out, i, await (await page.$('.shot')).screenshot({ type: 'png' })) : undefined;
      parts.push({ file: path.resolve(out), label: single ? '' : `Screen ${i + 1}`, y, height: Math.min(vh, pageH - y), raw, top });
    }

    log(single
      ? `Framed the first screen in a ${FRAME_NAMES[kind]}.`
      : `Framed ${parts.length} screens, each in a ${FRAME_NAMES[kind]}.`);
    const warnings = [];
    if (pageH < vh) warnings.push('The image is shorter than one screen. The rest of the screen is white.');
    return {
      ...frameResult(parts, { height: pageH, vw, vh, dpr, kind, host, dark: !!input.dark, bg, ...clock, keep: input.keepScreens }),
      split: single ? 'none' : 'screen',
      warnings,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

// Redraw a framed capture with another frame or background, from the unframed screens it kept
// (the `screens` and `framing` of a framed result made with keepScreens). Each frame overwrites
// its old file, so the capture changes in place. Takes about a second for one screen.
//   screens  [{ raw, top, out }]   framing  { w, h, dpr, host, dark }
//   frame    auto | phone | tablet | laptop | browser      frameBg  transparent | light | dark | gradient
// Returns { frame } (the kind that "auto" picked).
export async function redrawFrames({ screens, framing }, { frame, frameBg, frameTime, frameDate }, { onLog = () => {} } = {}) {
  if (!screens?.length || !framing) throw new Error('This capture has no saved screens to redraw. Capture it again with a frame.');
  if (!FRAMES.includes(frame) || frame === 'none') throw new Error(`The frame "${frame}" is not supported. Use auto, phone, tablet, laptop, or browser.`);
  if (!FRAME_BACKGROUNDS.includes(frameBg)) throw new Error(`The frame background "${frameBg}" is not supported. Use transparent, light, dark, or gradient.`);
  const { w, h, dpr, host, dark } = framing;
  const clock = clockText(frameTime ?? framing.time, frameDate ?? framing.date);
  const kind = frame === 'auto' ? autoFrame(undefined, w) : frame;
  const browser = await launch({ browser: 'chromium', headed: false }, onLog);
  try {
    const ctx = await browser.newContext({ deviceScaleFactor: dpr, viewport: { width: 1200, height: 900 } });
    const page = await ctx.newPage();
    for (const s of screens) {
      const img = `data:image/png;base64,${(await fs.readFile(s.raw)).toString('base64')}`;
      const ext = path.extname(s.out).toLowerCase();
      // JPEG has no transparency.
      const bg = (ext === '.jpg' || ext === '.jpeg') && frameBg === 'transparent' ? 'light' : frameBg;
      await renderFrameTo(page, s.out, kind, { img, w, h, host, top: s.top, dark: dark || s.top?.dark, bg, ...clock });
    }
    onLog(`Redrew ${screens.length === 1 ? 'the screen' : `${screens.length} screens`} in a ${FRAME_NAMES[kind]}.`);
    return { frame: kind, ...clock };
  } finally {
    await browser.close().catch(() => {});
  }
}
