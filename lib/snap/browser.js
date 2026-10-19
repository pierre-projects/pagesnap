// Launching the browser (with a one-time download on first run) and the page context settings.

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';
import { findDevice } from './options.js';

const BROWSERS = { chromium, firefox, webkit };

function installBrowser(name, log) {
  // Use this same node binary so PATH doesn't matter.
  const cli = path.join(path.dirname(fileURLToPath(import.meta.resolve('playwright/package.json'))), 'cli.js');
  log(`Downloading ${name}. This occurs one time only.`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'install', name], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve()
      : reject(new Error(`The ${name} download failed. Run "npx playwright install ${name}" to try again.\n${err.trim()}`))));
  });
}

export async function launch(o, log) {
  const type = BROWSERS[o.browser];
  const go = () => type.launch({ headless: !o.headed });
  try {
    return await go();
  } catch (e) {
    if (!/Executable doesn't exist/i.test(e.message)) throw e;
    await installBrowser(o.browser, log);
    return go();
  }
}

// Viewport, device emulation and media settings for a normalized options object.
export function contextOptions(o) {
  let ctx = {
    viewport: { width: o.width, height: o.height },
    deviceScaleFactor: o.scale,
  };
  if (o.device) {
    const { defaultBrowserType, ...rest } = findDevice(o.device);
    ctx = rest;
    if (o.browser === 'firefox') delete ctx.isMobile; // unsupported in Firefox
  }
  // Ask for reduced motion: sites that respect it skip reveal-on-scroll and entrance animations,
  // which otherwise leave content invisible once the page is scrolled back to the top.
  ctx.reducedMotion = 'reduce';
  if (o.dark) ctx.colorScheme = 'dark';
  if (o.userAgent) ctx.userAgent = o.userAgent;
  ctx.ignoreHTTPSErrors = true;
  return ctx;
}
