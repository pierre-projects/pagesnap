// Capture engine shared by the CLI and the UI server: full-page screenshots that cope with
// lazy loading, infinite scroll, cookie banners and sticky headers. Outputs PNG, JPEG or PDF.
//
// One capture runs these steps, each in its own module:
//   options.js  normalize()       defaults and validation
//   browser.js  launch()          start the browser (one-time download on first run)
//   errors.js   loadError()       turn load failures into readable messages
//   cookies.js  handleCookies()   close or hide cookie banners
//   scroll.js   scrollThrough()   load lazy images and infinite-scroll content
//   layout.js   prepareLayout()   sticky bars, 100vh sections, reveal animations
//   regions.js  findRegions()     the parts to capture for each split mode
//   capture.js  captureImage()    write PNG/JPEG files (or capturePdf() for PDF)
//   frames.js   frameHtml()       device frames for captureFramed(): phone, tablet, laptop, browser
//   reframe.js  reframe()         put an existing capture in a frame, without loading the site again
//   batch.js    snapMany()        capture a list of pages, a few at a time in one browser

import path from 'node:path';
import fs from 'node:fs/promises';
import { normalize } from './options.js';
import { launch, contextOptions } from './browser.js';
import { loadError, waitForError } from './errors.js';
import { handleCookies } from './cookies.js';
import { scrollThrough } from './scroll.js';
import { prepareLayout } from './layout.js';
import { captureImage, captureFramed, capturePdf } from './capture.js';
import { sleep } from './util.js';

export { DEFAULTS, SPLITS, normalize, listDevices, findDevice, hostOf, hasScheme } from './options.js';
export { FRAMES, FRAME_BACKGROUNDS } from './frames.js';
export { reframe, redrawFrames } from './reframe.js';
export { launch } from './browser.js';
export { snapMany, parseUrlList, pageSlug, MAX_LIST } from './batch.js';

export const STEPS = ['load', 'cookies', 'scroll', 'capture'];

// Capture `input.url` to `input.out`. Returns { files, parts, height, width, dpr, split, warnings }.
// onStep(name) fires as each of STEPS starts; onProgress({ y, height }) during the scroll.
// Aborting `signal` closes the browser and rejects with "The capture was cancelled."
// With `browser` (from launch()), the capture runs in a new context of that browser and closes
// only its context, so several captures can share one browser.
export async function snap(input, { onLog = () => {}, onStep = () => {}, onProgress = () => {}, signal, browser: shared } = {}) {
  const o = normalize(input);
  const warnings = [];
  const log = (msg) => onLog(msg);
  const warn = (msg) => { warnings.push(msg); log(`Warning: ${msg}`); };
  const cancelled = () => new Error('The capture was cancelled.');
  const check = () => { if (signal?.aborted) throw cancelled(); };
  check();

  onStep('load');
  const browser = shared ?? await launch(o, log);
  let context;
  // Closing the browser (or our context of a shared one) makes every pending Playwright call
  // reject, which unwinds the steps below.
  const onAbort = () => { (shared ? context : browser)?.close().catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    check();
    context = await browser.newContext(contextOptions(o));
    check();
    const page = await context.newPage();

    log(`Loading ${o.url}`);
    const res = await page.goto(o.url, { waitUntil: 'domcontentloaded', timeout: o.timeout }).catch((e) => {
      check();
      throw loadError(e, o);
    });
    if (res && res.status() >= 400) warn(`The server sent HTTP ${res.status()}. The capture may show an error page.`);
    await page.waitForLoadState('load', { timeout: o.timeout }).catch(() => log('The page did not finish loading in time. Continuing.'));
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    if (o.waitFor) {
      log(`Waiting for "${o.waitFor}".`);
      await page.waitForSelector(o.waitFor, { timeout: o.timeout }).catch((e) => {
        check();
        throw waitForError(e, o);
      });
    }

    check();
    onStep('cookies');
    await handleCookies(page, o.cookies, log);
    check();
    onStep('scroll');
    if (o.scroll) {
      log('Scrolling the page to load lazy content.');
      await scrollThrough(page, o.maxHeight, o.maxScrolls, log, onProgress);
    }
    // Banners sometimes appear late (after scroll or a timer).
    await handleCookies(page, o.cookies === 'off' ? 'off' : 'hide', log);
    // In a device frame the page scrolls like on a real screen, so fixed headers stay where they
    // are ("keep") instead of showing once at the top. "hide" still hides them.
    const framed = o.frame !== 'none' && o.format !== 'pdf';
    await prepareLayout(page, framed && o.sticky === 'once' ? 'keep' : o.sticky, o.hide);
    await page.evaluate(() => document.fonts?.ready);
    await sleep(o.wait);

    check();
    onStep('capture');
    await fs.mkdir(path.dirname(path.resolve(o.out)), { recursive: true });
    log('Capturing the page.');
    const result = o.format === 'pdf' ? await capturePdf(page, o.out, o.pdfPaged)
      : framed ? await captureFramed(page, o.out, o, log)
      : await captureImage(page, o.out, o, log);
    return {
      ...result,
      files: result.files.map((f) => path.resolve(f)),
      parts: (result.parts ?? result.files.map((file) => ({ file, label: '' }))).map((p) => ({ ...p, file: path.resolve(p.file) })),
      split: o.split,
      frame: result.frame ?? 'none',
      warnings,
    };
  } catch (e) {
    if (signal?.aborted) throw cancelled();
    throw e;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await (shared ? context?.close() : browser.close())?.catch(() => {});
  }
}
