#!/usr/bin/env node
// pagesnap: full-page screenshots that cope with lazy loading, infinite scroll,
// cookie banners and sticky headers. Outputs PNG, JPEG or PDF.
// The capture engine lives in lib/snap/; `--ui` starts the local web UI (lib/server.js).

import { parseArgs } from 'node:util';
import path from 'node:path';
import { snap, reframe, listDevices } from '../lib/snap/index.js';

const HELP = `
Usage: pagesnap <url> [options]
       pagesnap frame <image...> [--frame kind] [--frame-bg bg] [-d device | -w px -H px] [--url url] [--split screen] [-o file]
       pagesnap --ui [--port 4777] [--out-dir ./captures] [--no-open]

Frame an existing capture
  pagesnap frame puts an image you already have (a pagesnap capture, or its parts in order) in a
  device frame, without loading the site again. The viewport comes from -d or -w/-H (height 900
  if not given); the pixel density from -s, else image width ÷ viewport width. --url sets the
  address bar text. --split screen frames every screen instead of only the first.
  Output: <image>-framed.png unless -o is given.

Output
  -o, --out <file>          Output file (default: <host>.<format>)
  -f, --format <fmt>        png | jpeg | pdf (default: from --out extension, else png)
  -q, --quality <0-100>     JPEG quality (default 85)
      --pdf-paged           PDF on A4 pages instead of one long page

Split into parts (PNG/JPEG)
      --split <mode>        screen | sections | height | elements (default: one image)
                              screen    one image per screenful
                              sections  one image per section of the page (header, hero, ..., footer)
                              height    slices of --slice-height
                              elements  one image per element that matches --parts
      --slice-height <h>    Slice height in px, or a4 | letter (sets --split height)
      --parts <css>         Element selector, repeatable (sets --split elements)
      --exact-cuts          Screens/height: cut at exact multiples, even through content
                            (default: move each cut up to a gap between content)

Device frame (PNG/JPEG)
      --frame <kind>        auto | phone | tablet | laptop | browser
                            Saves the first screen inside that device (auto: matches the viewport).
                            With --split screen, every screen gets a frame.
      --frame-bg <bg>       transparent | light | dark | gradient (default transparent)
      --frame-time <text>   The status bar clock on phone and tablet frames (default 9:41)
      --frame-date <text>   The date next to it on tablet frames (default "Tue Jan 9"; "" hides it)

Viewport / device
  -w, --width <px>          Viewport width (default 1440)
  -H, --height <px>         Viewport height (default 900)
  -s, --scale <n>           Device scale factor, e.g. 2 for retina (default 1)
  -d, --device <name>       Emulate a device, e.g. "iPhone 15 Pro", "Pixel 7"
      --list-devices        Print device names and exit
      --dark                Emulate prefers-color-scheme: dark
      --user-agent <ua>     Override the user agent
  -b, --browser <name>      chromium | firefox | webkit (default chromium; PDF needs chromium)

Page handling
      --cookies <mode>      reject | accept | hide | off (default reject; falls back to hide)
      --sticky <mode>       once | hide | keep (default once: fixed/sticky bars appear only at top)
      --no-scroll           Skip the lazy-load scroll pass
      --max-height <px>     Stop scrolling infinite pages past this height (default 20000)
      --max-scrolls <n>     Max scroll steps (default 60)
      --hide <css>          Extra selectors to hide (repeatable)
      --wait <ms>           Extra wait before capture (default 500)
      --wait-for <css>      Wait for this selector before doing anything
  -t, --timeout <ms>        Navigation timeout (default 45000)
      --headed              Show the browser window (debugging)

Web UI
      --ui                  Start the local web UI instead of capturing
      --port <n>            UI port (default 4777)
      --out-dir <dir>       Where the UI saves captures (default ./captures)
      --no-open             Don't open the browser automatically
  -h, --help                Show this help

Examples
  pagesnap https://example.com
  pagesnap https://news.ycombinator.com -o hn.jpg -q 70
  pagesnap https://github.com -d "iPhone 15 Pro" -o gh-mobile.png
  pagesnap https://en.wikipedia.org/wiki/Web_page -f pdf
  pagesnap https://example.com --split sections -o parts/example.png
  pagesnap https://example.com --parts ".card" --parts "footer"
  pagesnap https://example.com -d "iPhone 15 Pro" --frame auto -o phone.png
  pagesnap https://example.com --frame laptop --frame-bg gradient
  pagesnap --ui
`;

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', short: 'o' },
    format: { type: 'string', short: 'f' },
    quality: { type: 'string', short: 'q' },
    'pdf-paged': { type: 'boolean' },
    width: { type: 'string', short: 'w' },
    height: { type: 'string', short: 'H' },
    scale: { type: 'string', short: 's' },
    device: { type: 'string', short: 'd' },
    'list-devices': { type: 'boolean' },
    dark: { type: 'boolean' },
    'user-agent': { type: 'string' },
    browser: { type: 'string', short: 'b' },
    cookies: { type: 'string' },
    sticky: { type: 'string' },
    'no-scroll': { type: 'boolean' },
    'max-height': { type: 'string' },
    'max-scrolls': { type: 'string' },
    hide: { type: 'string', multiple: true },
    wait: { type: 'string' },
    'wait-for': { type: 'string' },
    split: { type: 'string' },
    'slice-height': { type: 'string' },
    parts: { type: 'string', multiple: true },
    'exact-cuts': { type: 'boolean' },
    frame: { type: 'string' },
    'frame-bg': { type: 'string' },
    'frame-time': { type: 'string' },
    'frame-date': { type: 'string' },
    timeout: { type: 'string', short: 't' },
    headed: { type: 'boolean' },
    ui: { type: 'boolean' },
    port: { type: 'string' },
    'out-dir': { type: 'string' },
    'no-open': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
    url: { type: 'string' },
  },
});

const die = (msg) => { console.error(`pagesnap: ${msg}`); process.exit(1); };

if (opt['list-devices']) {
  console.log(listDevices().join('\n'));
  process.exit(0);
}

if (opt.ui) {
  const { startServer } = await import('../lib/server.js');
  await startServer({ port: opt.port, outDir: opt['out-dir'], open: !opt['no-open'] }).catch((e) => die(e.message));
} else if (positionals[0] === 'frame' && !opt.help) {
  // pagesnap frame <image...>: put an existing capture in a device frame, without loading the site.
  const images = positionals.slice(1);
  if (!images.length) die('Give the image to frame, for example: pagesnap frame shot.png --frame phone');
  const first = images[0];
  const out = opt.out ?? `${first.slice(0, first.length - path.extname(first).length)}-framed.png`;
  try {
    const { files } = await reframe({
      files: images.map((f) => path.resolve(f)),
      out,
      device: opt.device,
      viewport: { width: opt.width, height: opt.height },
      dpr: opt.scale,
      url: opt.url,
      frame: opt.frame || 'auto',
      frameBg: opt['frame-bg'],
      frameTime: opt['frame-time'],
      frameDate: opt['frame-date'],
      dark: opt.dark,
      every: opt.split === 'screen',
    }, { onLog: (msg) => console.error('[pagesnap]', msg) });
    for (const f of files) console.log(f);
  } catch (e) {
    die(e.message.split('\n')[0]);
  }
} else {
  if (opt.help || positionals.length === 0) {
    console.log(HELP.trim());
    process.exit(opt.help ? 0 : 1);
  }
  try {
    const { files } = await snap({
      url: positionals[0],
      out: opt.out,
      format: opt.format,
      quality: opt.quality,
      pdfPaged: opt['pdf-paged'],
      width: opt.width,
      height: opt.height,
      scale: opt.scale,
      device: opt.device,
      dark: opt.dark,
      userAgent: opt['user-agent'],
      browser: opt.browser,
      cookies: opt.cookies,
      sticky: opt.sticky,
      scroll: opt['no-scroll'] ? false : undefined,
      maxHeight: opt['max-height'],
      maxScrolls: opt['max-scrolls'],
      hide: opt.hide,
      wait: opt.wait,
      waitFor: opt['wait-for'],
      split: opt.split,
      sliceHeight: opt['slice-height'],
      parts: opt.parts,
      exactCuts: opt['exact-cuts'],
      frame: opt.frame,
      frameBg: opt['frame-bg'],
      frameTime: opt['frame-time'],
      frameDate: opt['frame-date'],
      timeout: opt.timeout,
      headed: opt.headed,
    }, { onLog: (msg) => console.error('[pagesnap]', msg) });
    for (const f of files) console.log(f);
  } catch (e) {
    die(e.message.split('\n')[0]);
  }
}
