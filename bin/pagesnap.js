#!/usr/bin/env node
// pagesnap: full-page screenshots that cope with lazy loading, infinite scroll,
// cookie banners and sticky headers. Outputs PNG, JPEG or PDF.
// The capture engine lives in lib/snap/; `--ui` starts the local web UI (lib/server.js).

import { parseArgs } from 'node:util';
import path from 'node:path';
import fs from 'node:fs/promises';
import { snap, snapMany, reframe, listDevices, normalize, parseUrlList, pageSlug, findPages, MAX_LIST } from '../lib/snap/index.js';

const HELP = `
Usage: pagesnap <url> [options]
       pagesnap <url> <url...> [--out-dir dir] [-j 3] [options]
       pagesnap --list urls.txt [--out-dir dir] [-j 3] [options]
       pagesnap --site <url> [--under path] [--out-dir dir] [options]
       pagesnap pages <url> [--under path] [--limit 200] [--find auto|sitemap|crawl]
       pagesnap frame <image...> [--frame kind] [--frame-bg bg] [-d device | -w px -H px] [--url url] [--split screen] [-o file]
       pagesnap --ui [--port 4777] [--out-dir ./captures] [--no-open]

Frame an existing capture
  pagesnap frame puts an image you already have (a pagesnap capture, or its parts in order) in a
  device frame, without loading the site again. The viewport comes from -d or -w/-H (height 900
  if not given); the pixel density from -s, else image width ÷ viewport width. --url sets the
  address bar text. --split screen frames every screen instead of only the first.
  Output: <image>-framed.png unless -o is given.

Capture a list of pages
  Give several URLs, or a file with one URL on each line (--list; "-" reads standard input;
  blank lines and lines that start with # are skipped). Every page gets the same options.
  Files are named after each page, for example example.com_docs_intro.png.
      --list <file>         Read the URLs from this file (repeatable)
      --out-dir <dir>       Where the list's files go (default: the current folder)
  -j, --parallel <n>        Pages to capture at the same time (default 3)

Find the pages of a site
  pagesnap pages prints the pages of a site, one URL on each line, to make a list you can edit.
  --site finds them and captures them all at once. The pages come from the site's sitemaps
  (named in robots.txt, or at /sitemap.xml); with no sitemap, pagesnap follows the links on the
  site, from the given URL down. A path in the URL (example.com/docs) keeps only the pages under it.
      --site <url>          Capture every page of this site (up to 200)
      --under <path>        Only pages under this path, for example blog or docs/api
      --limit <n>           The most pages to find (default 200)
      --find <mode>         auto | sitemap | crawl (default auto: the sitemap, else follow links)

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
  pagesnap example.com example.org/about --out-dir shots
  pagesnap --list urls.txt -d "iPhone 15 Pro" -j 4 --out-dir shots/mobile
  pagesnap pages example.com > urls.txt
  pagesnap --site example.com/blog --out-dir shots/blog
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
    list: { type: 'string', multiple: true },
    parallel: { type: 'string', short: 'j' },
    site: { type: 'string' },
    under: { type: 'string' },
    limit: { type: 'string' },
    find: { type: 'string' },
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
} else if (positionals[0] === 'pages' && !opt.help) {
  // pagesnap pages <url>: print the site's pages, to edit and pass to --list.
  if (!positionals[1]) die('Give the site, for example: pagesnap pages example.com > urls.txt');
  const { urls } = await sitePages(positionals[1], opt.limit === undefined ? 200 : Number(opt.limit));
  for (const u of urls) console.log(u);
} else {
  const urls = positionals.slice();
  for (const file of opt.list ?? []) {
    let text;
    try { text = file === '-' ? await readStdin() : await fs.readFile(file, 'utf8'); }
    catch (e) { die(`The list "${file}" could not be read. ${e.code === 'ENOENT' ? 'The file does not exist.' : e.message}`); }
    urls.push(...parseUrlList(text));
  }
  if (opt.site && !opt.help) {
    const limit = opt.limit === undefined ? MAX_LIST : Number(opt.limit);
    if (limit > MAX_LIST) die(`A capture can have at most ${MAX_LIST} pages. Use --limit ${MAX_LIST} or less, or use --under to pick a part of the site.`);
    urls.push(...(await sitePages(opt.site, limit)).urls);
  }
  if (opt.help || urls.length === 0) {
    if (opt.list && !opt.help) die('The list has no URLs. Put one URL on each line.');
    console.log(HELP.trim());
    process.exit(opt.help ? 0 : 1);
  }
  if (urls.length > 1 || opt.list || opt.site) await captureList([...new Set(urls)]);
  else await captureOne(urls[0]);
}

// The capture options from the command line, for any URL.
function captureOptions() {
  return {
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
  };
}

async function captureOne(url) {
  try {
    const { files } = await snap({ ...captureOptions(), url, out: opt.out }, { onLog: (msg) => console.error('[pagesnap]', msg) });
    for (const f of files) console.log(f);
  } catch (e) {
    die(e.message.split('\n')[0]);
  }
}

// Several pages: each gets its own file in --out-dir. One page failing does not stop the others;
// the exit code is 1 when any page failed.
async function captureList(urls) {
  if (opt.out) die('With several URLs, use --out-dir for the folder. -o names a single file.');
  if (urls.length > MAX_LIST) die(`The list has ${urls.length} URLs. The most is ${MAX_LIST}. Split the list into smaller files.`);
  const parallel = opt.parallel === undefined ? 3 : Number(opt.parallel);
  if (!Number.isInteger(parallel) || parallel < 1 || parallel > 16) die('The --parallel value must be a whole number from 1 to 16.');
  const dir = path.resolve(opt['out-dir'] || '.');

  // Check every URL and the options before starting, so a typo on line 40 does not waste a run.
  const base = captureOptions();
  const items = [];
  const bad = [];
  const taken = new Set();
  for (const url of urls) {
    let o;
    try { o = normalize({ ...base, url }); } catch (e) { bad.push(`  ${url}: ${e.message}`); continue; }
    const ext = o.format === 'jpeg' ? 'jpg' : o.format;
    const slug = pageSlug(o.url);
    let name = `${slug}.${ext}`;
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${slug}_${i}.${ext}`;
    taken.add(name.toLowerCase());
    items.push({ ...base, url: o.url, out: path.join(dir, name) });
  }
  if (bad.length) die(`${bad.length === 1 ? 'One URL is' : `${bad.length} URLs are`} not valid. Nothing was captured.\n${bad.join('\n')}`);

  const n = items.length;
  const width = String(n).length;
  let ended = 0;
  console.error(`[pagesnap] Capturing ${n} pages, ${Math.min(parallel, n)} at a time, to ${dir}`);
  const controller = new AbortController();
  process.once('SIGINT', () => { console.error('[pagesnap] Cancelling.'); controller.abort(); });
  const results = await snapMany(items, {
    parallel,
    signal: controller.signal,
    // Logs of pages loading at the same time would mix, so only warnings and downloads show.
    onLog: (msg, i) => { if (/^(Warning|Downloading)/.test(msg)) console.error('[pagesnap]', i === undefined ? msg : `${items[i].url}: ${msg}`); },
    onEnd: (i, r) => {
      ended++;
      const tag = `[${String(ended).padStart(width)}/${n}]`;
      if (r.error) console.error(`${tag} failed  ${r.url}\n${' '.repeat(tag.length)}         ${r.error}`);
      else {
        console.error(`${tag} saved   ${r.url}`);
        for (const f of r.files) console.log(f);
      }
    },
  }).catch((e) => die(e.message.split('\n')[0]));
  const failed = results.filter((r) => r.error);
  if (!failed.length) {
    console.error(`[pagesnap] All ${n} pages were captured.`);
    return;
  }
  console.error(`[pagesnap] ${n - failed.length} of ${n} pages were captured. ${failed.length} failed:`);
  for (const r of failed) console.error(`  ${r.url}: ${r.error}`);
  process.exit(1);
}

// The pages of `site`, for `pagesnap pages` and --site. Progress goes to stderr.
async function sitePages(site, limit) {
  if (!Number.isInteger(limit) || limit < 1) die('The --limit value must be a whole number of 1 or more.');
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  let last = Date.now();
  try {
    const r = await findPages(site, {
      limit, under: opt.under, mode: opt.find ?? 'auto', signal: controller.signal,
      onLog: (msg) => console.error('[pagesnap]', msg),
      onProgress: ({ found }) => {
        if (Date.now() - last < 1000) return;
        last = Date.now();
        console.error(`[pagesnap] ${found} pages so far`);
      },
    });
    if (r.truncated) console.error(`[pagesnap] The site has more than ${limit} pages. Use --limit for more, or --under to pick a part of the site.`);
    return r;
  } catch (e) {
    die(e.message.split('\n')[0]);
  }
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}
