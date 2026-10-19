// Writing the output: images (whole, tiled, or split into parts) and PDFs.

import path from 'node:path';
import { findRegions } from './regions.js';
import { autoFrame, frameHtml, topColorInPage, FRAME_NAMES } from './frames.js';
import { findDevice, hostOf } from './options.js';
import { sleep } from './util.js';
import fs from 'node:fs/promises';

// Where a framed capture keeps its unframed screens: <dir of out>/.frames/<out name>/.
// Kept apart from the captures so the folder and History only show finished images.
export function screensDir(out) {
  return path.join(path.dirname(out), '.frames', path.basename(out, path.extname(out)));
}

// Save one unframed screen (PNG bytes) for later redraws. Returns its path.
export async function keepScreen(out, i, png) {
  const dir = screensDir(out);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `screen-${String(i + 1).padStart(2, '0')}.png`);
  await fs.writeFile(file, png);
  return file;
}

// Chromium can't rasterize a single capture taller than this; taller pages are split.
const MAX_TILE = 16000;

const SPLIT_NAMES = { screen: 'screens', sections: 'sections', height: 'slices', elements: 'elements' };

export async function pageSize(page) {
  return page.evaluate(() => {
    const se = document.scrollingElement || document.documentElement;
    return { width: se.scrollWidth, height: se.scrollHeight, dpr: window.devicePixelRatio || 1 };
  });
}

// File-name tag from a part's label: lowercase words, cut at a word boundary near 40 characters.
function slug(s) {
  const full = String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (full.length <= 40) return full;
  const cut = full.slice(0, 41);
  return cut.slice(0, cut.lastIndexOf('-') > 15 ? cut.lastIndexOf('-') : 40);
}

// PNG/JPEG. Returns { files, parts: [{ file, label, y, height }], height, width, dpr }.
export async function captureImage(page, file, o, log) {
  const { width, height, dpr } = await pageSize(page);
  const base = { type: o.format, ...(o.format === 'jpeg' ? { quality: o.quality } : {}) };
  // The limit is in device pixels, so retina/mobile captures split sooner.
  const tile = Math.floor(MAX_TILE / dpr);

  // 1. The parts the person asked for, in CSS px.
  const regions = await findRegions(page, o, { width, height }, log);

  // 2. Keep every region on the page and under the tile limit.
  const shots = [];
  for (const r of regions) {
    const x = Math.max(0, Math.floor(r.x ?? 0));
    const w = Math.min(width - x, Math.ceil(r.width ?? width));
    const top = Math.max(0, Math.floor(r.y));
    const bottom = Math.min(height, Math.ceil(r.y + r.height));
    const pieces = Math.ceil((bottom - top) / tile);
    for (let i = 0, y = top; y < bottom; y += tile, i++) {
      const label = pieces > 1 && r.label ? `${r.label} (part ${i + 1} of ${pieces})` : r.label;
      shots.push({ x, y, width: w, height: Math.min(tile, bottom - y), label, name: r.label });
    }
  }
  if (!shots.length) throw new Error('The page has nothing to capture. Its height is 0 px.');

  // 3. One unsplit, untiled capture keeps the exact file name that was asked for.
  if (shots.length === 1 && o.split === 'none') {
    await page.screenshot({ ...base, path: file, fullPage: true });
    return { files: [file], parts: [{ file, label: '', y: 0, height }], height, width, dpr };
  }
  const ext = path.extname(file);
  const stem = file.slice(0, file.length - ext.length);
  const pad = shots.length > 99 ? 3 : 2;
  const parts = [];
  for (const [i, s] of shots.entries()) {
    const tag = slug(s.name || '');
    const part = `${stem}-${String(i + 1).padStart(pad, '0')}${tag ? `-${tag}` : ''}${ext}`;
    await page.screenshot({ ...base, path: part, fullPage: true, clip: { x: s.x, y: s.y, width: s.width, height: s.height } });
    parts.push({ file: part, label: s.label, y: s.y, height: s.height });
  }
  log(o.split === 'none'
    ? `The page is ${height} px tall. Saved it as ${parts.length} parts.`
    : `Saved ${parts.length} ${parts.length === 1 ? 'part' : 'parts'} (${SPLIT_NAMES[o.split]}).`);
  return { files: parts.map((p) => p.file), parts, height, width, dpr };
}

// Screens inside a device frame: the first screen, or (with the Screens split) every screen, taken
// by scrolling the page like a person would. The last screen ends at the bottom of the page, so
// every frame holds a full screen. Returns the same shape as captureImage, plus `frame`.
export async function captureFramed(page, file, o, log) {
  const { height, dpr } = await pageSize(page);
  const { vw, vh } = await page.evaluate(() => ({ vw: window.innerWidth, vh: window.innerHeight }));
  const kind = o.frame === 'auto' ? autoFrame(findDevice(o.device), vw) : o.frame;

  const ys = [0];
  if (o.split === 'screen') {
    for (let y = vh; y < height; y += vh) ys.push(Math.min(y, Math.max(0, height - vh)));
    // The last step can repeat the one before it when the page ends exactly on a screen.
    while (ys.length > 1 && ys[ys.length - 1] === ys[ys.length - 2]) ys.pop();
  }

  const ext = path.extname(file);
  const stem = file.slice(0, file.length - ext.length);
  const single = ys.length === 1;
  const host = hostOf(o.url);

  // Frames render in their own context at the capture's pixel density, so the screen stays sharp.
  const ctx = await page.context().browser().newContext({ deviceScaleFactor: dpr, viewport: { width: 1200, height: 900 } });
  const framePage = await ctx.newPage();
  const parts = [];
  try {
    for (const [i, y] of ys.entries()) {
      await page.evaluate((top) => window.scrollTo({ top, left: 0, behavior: 'instant' }), y);
      await sleep(150);
      const shot = await page.screenshot({ type: 'png' });
      const top = await page.evaluate(topColorInPage);
      const out = single ? file : `${stem}-${String(i + 1).padStart(ys.length > 99 ? 3 : 2, '0')}${ext}`;
      await renderFrameTo(framePage, out, kind, {
        // Browser bars go dark on a dark page (or with --dark), so the chrome matches the site.
        img: `data:image/png;base64,${shot.toString('base64')}`, w: vw, h: vh, host, top, dark: o.dark || top.dark, bg: o.frameBg,
        time: o.frameTime, date: o.frameDate,
      }, { quality: o.quality });
      const raw = o.keepScreens ? await keepScreen(file, i, shot) : undefined;
      parts.push({ file: out, label: single ? '' : `Screen ${i + 1}`, y, height: Math.min(vh, height - y), raw, top });
    }
  } finally {
    await ctx.close();
    await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' })).catch(() => {});
  }

  log(single
    ? `Saved the first screen in a ${FRAME_NAMES[kind]} frame.`
    : `Saved ${parts.length} screens, each in a ${FRAME_NAMES[kind]} frame.`);
  return frameResult(parts, { height, vw, vh, dpr, kind, host, dark: !!o.dark, bg: o.frameBg, time: o.frameTime, date: o.frameDate, keep: o.keepScreens });
}

// Draw one frame with frameHtml() in `framePage` and save it to `out` (PNG, or JPEG by extension).
// The page's context sets the pixel density. Shared by framed captures, reframe and redraws.
export async function renderFrameTo(framePage, out, kind, frameOpts, { quality = 90 } = {}) {
  await framePage.setContent(frameHtml(kind, frameOpts), { waitUntil: 'load' });
  const stage = await framePage.$('.stage');
  const box = await stage.boundingBox();
  await framePage.setViewportSize({ width: Math.ceil(box.width), height: Math.ceil(box.height) });
  const ext = path.extname(out).toLowerCase();
  const type = ext === '.jpg' || ext === '.jpeg' ? 'jpeg' : 'png';
  await stage.screenshot({
    path: out, type, ...(type === 'jpeg' ? { quality } : {}), omitBackground: frameOpts.bg === 'transparent',
  });
}

// The result of a framed capture or reframe. With `keep`, `screens` lists the unframed screens and
// the settings to redraw them (see redrawFrames in reframe.js).
export function frameResult(parts, { height, vw, vh, dpr, kind, host, dark, bg, time, date, keep }) {
  const result = { files: parts.map((p) => p.file), parts: parts.map(({ raw, top, ...p }) => p), height, width: vw, dpr, frame: kind };
  if (keep) {
    result.screens = parts.map((p) => ({ raw: p.raw, top: p.top, out: p.file }));
    result.framing = { w: vw, h: vh, dpr, host, dark, bg, time, date };
  }
  return result;
}

export async function capturePdf(page, file, paged) {
  await page.emulateMedia({ media: 'screen' });
  const { width, height, dpr } = await pageSize(page);
  if (paged) {
    await page.pdf({ path: file, format: 'A4', printBackground: true });
  } else {
    // One continuous page (PDF caps a page at 200in = 19200 CSS px; Chromium paginates beyond that).
    await page.pdf({
      path: file, printBackground: true, width: `${width}px`, height: `${Math.min(height + 1, 19200)}px`,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });
  }
  return { files: [file], height, width, dpr };
}
