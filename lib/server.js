// Local web UI for pagesnap: a dependency-free HTTP server on 127.0.0.1 that queues captures,
// streams their progress over SSE and serves the results from the output folder.

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { snap, reframe, redrawFrames, normalize, listDevices, hostOf, pageSlug, launch, findPages, DEFAULTS, STEPS, FRAMES, FRAME_BACKGROUNDS, MAX_LIST } from './snap/index.js';
import { writeZip } from './zip.js';

const UI_DIR = fileURLToPath(new URL('../ui/', import.meta.url));
// The UI's own files, by URL path: the page, its stylesheet, and the modules in ui/js/.
// Nothing else under ui/ is served.
const UI_FILES = {
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
};
const UI_MODULE = /^\/js\/([a-z][a-z0-9-]*)\.js$/;
// Engine modules the UI imports as they are: /js/frames.js draws the same device frames in the
// browser as on the server, so the live frame preview matches the saved image.
const SHARED_MODULES = { '/js/frames.js': fileURLToPath(new URL('./snap/frames.js', import.meta.url)) };
function uiAsset(p) {
  if (SHARED_MODULES[p]) return { abs: SHARED_MODULES[p], type: 'text/javascript; charset=utf-8' };
  if (UI_FILES[p]) return UI_FILES[p];
  const m = p.match(UI_MODULE);
  return m ? { file: path.join('js', `${m[1]}.js`), type: 'text/javascript; charset=utf-8' } : null;
}
const DEFAULT_PORT = 4777;
const CAPTURE_EXT = new Set(['.png', '.jpg', '.jpeg', '.pdf']);
const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.pdf': 'application/pdf' };
const MAX_BODY = 64 * 1024;
const JOB_TTL = 30 * 60 * 1000;
// Captures that run at the same time. Each loads a whole page, so more mostly adds memory.
const PARALLEL = 3;
const MAX_NAME = 80; // characters in a list name
// Remembers the URL and settings behind each capture; the leading dot keeps it out of /files.
const INDEX_FILE = '.pagesnap-history.json';
// Matches split parts ("name-01.png", "name-02-pricing.png") so they group back into one capture.
// Lazy so a timestamp ("-164428") or a number in a part name ("-top-10-tips") is not taken as
// the part number.
const PART_RE = /^(.*?)-(\d{2,3})(-[a-z0-9-]+)?(\.(png|jpe?g))$/i;

const log = (...a) => console.error('[pagesnap ui]', ...a);

function openExternal(target, { select = false } = {}) {
  let cmd;
  let args;
  if (process.platform === 'win32') {
    [cmd, args] = select ? ['explorer', [`/select,"${target}"`]] : ['cmd', ['/c', 'start', '""', `"${target}"`]];
  } else if (process.platform === 'darwin') {
    [cmd, args] = ['open', select ? ['-R', target] : [target]];
  } else {
    [cmd, args] = ['xdg-open', [select ? path.dirname(target) : target]];
  }
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: process.platform === 'win32' })
      .on('error', () => {}).unref();
  } catch { /* no desktop to open into: the URL is printed anyway */ }
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('The request is too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('The request body is not valid JSON.')); }
    });
    req.on('error', reject);
  });
}

export async function startServer({ port, outDir, open = true } = {}) {
  outDir = path.resolve(outDir || 'captures');
  await fs.mkdir(outDir, { recursive: true });

  // ---------- capture history index ----------
  // Always read the file fresh: another pagesnap UI may share this folder, and a copy kept
  // in memory would overwrite its entries.
  // The file holds the captures by id, and the lists they came from: { [list id]: { name, createdAt } }.
  const indexPath = path.join(outDir, INDEX_FILE);
  async function readIndexFile() {
    try {
      const j = JSON.parse(await fs.readFile(indexPath, 'utf8'));
      return { captures: j.captures ?? {}, lists: j.lists ?? {} };
    } catch { return { captures: {}, lists: {} }; }
  }
  const readIndex = async () => (await readIndexFile()).captures;
  const readLists = async () => (await readIndexFile()).lists;
  let indexWrite = Promise.resolve();
  // change(captures, lists) edits the two maps in place.
  function updateIndex(change) {
    // Serialize our own writes, re-read just before each one, and write-then-rename so a crash
    // never leaves half a file.
    indexWrite = indexWrite.then(async () => {
      const { captures, lists } = await readIndexFile();
      change(captures, lists);
      const tmp = `${indexPath}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify({ version: 1, captures, lists }, null, 1));
      await fs.rename(tmp, indexPath);
    }).catch((e) => log('could not save history:', e.message));
    return indexWrite;
  }

  // ---------- jobs ----------
  // Up to PARALLEL jobs run at once; the rest wait in `pending`, first in, first out.
  const jobs = new Map(); // id -> { status, events, listeners, controller, batch? }
  const pending = []; // queued jobs, in order
  const running = new Set();
  // A list capture: its jobs share one browser and one event stream.
  const batches = new Map(); // id -> { id, jobs, listeners, browser? }

  function write(res, type, data) {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  const ended = (job) => ['done', 'error', 'cancelled'].includes(job.status);

  function emit(job, type, data, { replay = true } = {}) {
    if (replay) job.events.push({ type, data });
    for (const res of job.listeners) write(res, type, data);
    // A list's stream carries every job's events except log lines (they stay on the job's own stream).
    const b = job.batch;
    if (b && type !== 'log') for (const res of b.listeners) write(res, 'job', { id: job.id, type, data });
    if (type === 'done' || type === 'error') {
      for (const res of job.listeners) res.end();
      job.listeners.clear();
      setTimeout(() => jobs.delete(job.id), JOB_TTL).unref();
      if (b && b.jobs.every(ended)) endBatch(b);
    }
  }

  function endBatch(b) {
    for (const res of b.listeners) { write(res, 'end', {}); res.end(); }
    b.listeners.clear();
    b.browser?.then((br) => br.close()).catch(() => {});
    b.browser = null;
    setTimeout(() => batches.delete(b.id), JOB_TTL).unref();
  }

  // Called when a job starts: everyone still waiting moves up one place.
  function announceQueue() {
    pending.forEach((job, i) => emit(job, 'queued', { ahead: i + 1 }, { replay: false }));
  }

  // Names picked but not yet written, so jobs running at the same time never pick the same one.
  const reserved = new Set();
  async function uniqueOut(url, format, slug = hostOf(url).replace(/[^a-z0-9.-]/gi, '_')) {
    const ext = format === 'jpeg' ? 'jpg' : format;
    const base = `${slug}-${stamp()}`;
    // "_n" rather than "-n" so it can't be mistaken for a split part ("-01", "-02").
    for (let i = 1; ; i++) {
      const name = i === 1 ? `${base}.${ext}` : `${base}_${i}.${ext}`;
      const key = name.toLowerCase();
      if (reserved.has(key)) continue;
      // Reserve before the await, so a job picking a name meanwhile skips this one.
      reserved.add(key);
      if (!(await exists(path.join(outDir, name)))) return path.join(outDir, name);
      reserved.delete(key);
    }
  }

  function pump() {
    while (running.size < PARALLEL && pending.length) {
      const job = pending.shift();
      running.add(job);
      job.start().finally(() => { running.delete(job); pump(); });
    }
    announceQueue();
  }

  // Queue a capture of `options`. With `run`, queue other work that ends in a capture instead:
  // run(out, hooks) returns a snap()-shaped result, and the history entry records `options`
  // (what "Capture again" repeats) plus `extra`. `batch` adds the job to a list capture, whose
  // files are named after each page.
  function enqueue(options, { run, extra = {}, batch } = {}) {
    const job = {
      id: randomUUID(), status: 'queued', events: [], listeners: new Set(), controller: new AbortController(), batch,
    };
    jobs.set(job.id, job);
    batch?.jobs.push(job);
    const ahead = pending.length + running.size;
    if (ahead >= PARALLEL) job.events.push({ type: 'queued', data: { ahead: ahead - PARALLEL + 1 } });

    job.start = async () => {
      if (job.status === 'cancelled') return;
      job.status = 'running';
      const started = Date.now();
      let lastProgress = 0;
      let out;
      try {
        out = await uniqueOut(options.url, options.format, batch ? pageSlug(options.url) : undefined);
        const hooks = {
          signal: job.controller.signal,
          onLog: (msg) => emit(job, 'log', msg),
          onStep: (step) => emit(job, 'step', step),
          onProgress: (p) => {
            // Throttle: the scroll loop reports every ~250 ms, the UI needs far fewer.
            if (Date.now() - lastProgress < 300) return;
            lastProgress = Date.now();
            emit(job, 'progress', p, { replay: false });
          },
        };
        const keepScreens = options.frame && options.frame !== 'none';
        const shared = batch && await batchBrowser(batch, options);
        if (job.controller.signal.aborted) throw new Error('The capture was cancelled.');
        const result = run ? await run(out, hooks) : await snap({ ...options, out, keepScreens }, { ...hooks, browser: shared });
        const files = result.files.map((f) => path.basename(f));
        const sizes = await Promise.all(result.files.map((f) => fs.stat(f).then((s) => s.size, () => 0)));
        const entry = {
          id: files[0], url: options.url, files, format: options.format, size: sizes.reduce((a, b) => a + b, 0),
          height: result.height, width: result.width, dpr: result.dpr, split: result.split, frame: result.frame,
          parts: result.parts.map((p) => ({ ...p, file: path.basename(p.file) })),
          ...(result.screens ? {
            screens: result.screens.map((sc) => ({ raw: path.relative(outDir, sc.raw).split(path.sep).join('/'), top: sc.top })),
            framing: result.framing,
          } : {}),
          ms: Date.now() - started, createdAt: Date.now(), warnings: result.warnings,
          options: { ...options, out: undefined },
          ...extra,
        };
        await updateIndex((index) => { index[entry.id] = entry; });
        job.status = 'done';
        emit(job, 'done', entry);
      } catch (e) {
        job.status = 'error';
        emit(job, 'error', { message: e.message.split('\n')[0], cancelled: job.controller.signal.aborted });
      } finally {
        if (out) reserved.delete(path.basename(out).toLowerCase());
      }
    };
    pending.push(job);
    pump();
    return job;
  }

  // The browser a list's captures share, started by its first capture.
  function batchBrowser(b, options) {
    b.browser ??= launch(normalize({ ...options, out: 'x' }), (msg) => log(msg));
    return b.browser;
  }

  // Queue a capture of each of `urls` with `options`, as one list.
  function enqueueBatch(urls, options, name = '') {
    const b = { id: randomUUID(), jobs: [], listeners: new Set(), browser: null, createdAt: Date.now() };
    // History groups the list's captures under this entry, and shows its name.
    updateIndex((captures, lists) => { lists[b.id] = { name, createdAt: b.createdAt }; });
    batches.set(b.id, b);
    for (const url of urls) enqueue({ ...options, url }, { batch: b, extra: { batch: b.id } });
    return b;
  }

  function cancel(job) {
    if (job.status === 'queued') {
      job.status = 'cancelled';
      pending.splice(pending.indexOf(job), 1);
      emit(job, 'error', { message: 'The capture was cancelled.', cancelled: true });
      return true;
    }
    if (job.status === 'running') { job.controller.abort(); return true; }
    return false;
  }

  // ---------- captures on disk ----------

  // Captures are served only from outDir, by bare filename.
  function captureFile(name) {
    let decoded;
    try { decoded = decodeURIComponent(name); } catch { return null; }
    if (!decoded || decoded !== path.basename(decoded) || decoded.startsWith('.')) return null;
    if (!CAPTURE_EXT.has(path.extname(decoded).toLowerCase())) return null;
    const full = path.resolve(outDir, decoded);
    return path.dirname(full) === outDir ? full : null;
  }

  // Every capture in outDir, newest first. Files the UI made carry their URL and settings;
  // files from the CLI or elsewhere are grouped by name and shown without them.
  // A framed capture's unframed screens live in outDir/.frames/<capture name>/screen-NN.png.
  // `rel` is that path relative to outDir, as stored in the history entry.
  function rawFile(rel) {
    const m = /^\.frames\/([^/\\]+)\/(screen-\d{2,3}\.png)$/.exec(String(rel));
    if (!m || m[1].startsWith('.') || m[1].includes('..')) return null;
    const full = path.resolve(outDir, '.frames', m[1], m[2]);
    return path.dirname(path.dirname(full)) === path.join(outDir, '.frames') ? full : null;
  }

  // One redraw at a time per capture: a second request waits for the first.
  const redraws = new Map();

  async function listCaptures() {
    const names = await fs.readdir(outDir).catch(() => []);
    const stats = new Map();
    await Promise.all(names.filter((n) => CAPTURE_EXT.has(path.extname(n).toLowerCase()) && !n.startsWith('.')).map(async (n) => {
      const st = await fs.stat(path.join(outDir, n)).catch(() => null);
      if (st?.isFile()) stats.set(n, st);
    }));

    const groups = new Map();
    const claimed = new Set();
    for (const entry of Object.values(await readIndex())) {
      const files = entry.files.filter((f) => stats.has(f));
      if (!files.length) continue;
      files.forEach((f) => claimed.add(f));
      groups.set(entry.id, { ...entry, files });
    }
    for (const [n, st] of stats) {
      if (claimed.has(n)) continue;
      const m = n.match(PART_RE);
      const key = m ? `parts:${m[1]}${m[4]}` : n;
      const ext = path.extname(n).toLowerCase();
      if (!groups.has(key)) {
        groups.set(key, { id: n, files: [], format: ext === '.pdf' ? 'pdf' : ext === '.png' ? 'png' : 'jpeg', createdAt: 0 });
      }
      const g = groups.get(key);
      g.files.push(n);
      g.createdAt = Math.max(g.createdAt, st.mtimeMs);
    }
    const out = [...groups.values()].map((g) => {
      g.files.sort();
      // A capture is named by its first file, whatever its part name is.
      if (!g.parts) g.id = g.files[0];
      g.size = g.files.reduce((s, f) => s + (stats.get(f)?.size ?? 0), 0);
      return g;
    });
    return out.sort((a, b) => b.createdAt - a.createdAt).slice(0, 300);
  }

  // Why capture `c` cannot be framed, or null. A frame needs the page as one continuous strip
  // of images, so PDFs, element boxes, and captures that already have a frame are out.
  function frameableProblem(c) {
    if (c.format === 'pdf') return 'A PDF cannot be put in a device frame. Capture the page as PNG or JPEG.';
    if (c.frame && c.frame !== 'none') return 'This capture already has a device frame. Use Capture again with other frame options.';
    if (c.split === 'elements') return 'A capture split by elements is not one continuous page, so it cannot go in a frame.';
    return null;
  }

  // Delete the captures with these ids: their files, kept screens, and history entries.
  // Returns how many were found and deleted.
  async function deleteCaptures(ids) {
    const wanted = new Set(ids);
    const found = (await listCaptures()).filter((c) => wanted.has(c.id));
    for (const g of found) {
      if (g.screens?.length) {
        const dir = rawFile(g.screens[0].raw);
        if (dir) await fs.rm(path.dirname(dir), { recursive: true, force: true });
      }
      for (const f of g.files) {
        const full = captureFile(f);
        if (full) await fs.unlink(full).catch(() => {});
      }
    }
    if (found.length) {
      await updateIndex((captures, lists) => {
        for (const g of found) delete captures[g.id];
        // A list with no captures left goes too, unless it is still running.
        const used = new Set(Object.values(captures).map((e) => e.batch).filter(Boolean));
        const running = (id) => batches.get(id)?.jobs.some((j) => !ended(j));
        for (const id of Object.keys(lists)) if (!used.has(id) && !running(id)) delete lists[id];
      });
    }
    return found.length;
  }

  const deleteCapture = async (id) => (await deleteCaptures([id])) > 0;

  // ---------- http ----------
  let actualPort;
  const allowedHosts = () => new Set([`localhost:${actualPort}`, `127.0.0.1:${actualPort}`, `[::1]:${actualPort}`]);

  const server = http.createServer(async (req, res) => {
    try {
      // Only answer requests addressed to this machine (blocks DNS rebinding), and refuse
      // state-changing requests sent by other sites' pages.
      const hosts = allowedHosts();
      if (!hosts.has(req.headers.host ?? '')) return send(res, 403, 'forbidden host');
      if (req.method !== 'GET' && req.headers.origin) {
        let originHost = '';
        try { originHost = new URL(req.headers.origin).host; } catch {}
        if (!hosts.has(originHost)) return send(res, 403, 'forbidden origin');
      }

      const url = new URL(req.url, `http://${req.headers.host}`);
      const p = url.pathname;

      const asset = req.method === 'GET' && uiAsset(p === '/' ? '/index.html' : p);
      if (asset) {
        const body = await fs.readFile(asset.abs ?? path.join(UI_DIR, asset.file)).catch(() => null);
        if (!body) return send(res, 404, 'not found');
        return send(res, 200, body, {
          'Content-Type': asset.type,
          'X-Content-Type-Options': 'nosniff',
          // No inline script or style anywhere in the UI, so neither needs 'unsafe-inline'.
          // (Setting element.style from app.js is allowed: CSP only blocks style attributes in markup.)
          ...(asset.file === 'index.html' ? {
            'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'",
          } : {}),
        });
      }

      if (req.method === 'GET' && p === '/api/config') {
        return send(res, 200, { defaults: DEFAULTS, devices: listDevices(), outDir, steps: STEPS, parallel: PARALLEL });
      }

      if (req.method === 'POST' && p === '/api/snap') {
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'The request must be JSON.' });
        const body = await readJson(req);
        // The UI picks what to capture; where it lands and whether a window shows are ours.
        delete body.out;
        delete body.headed;
        let options;
        try { options = normalize({ ...body, out: 'x' }); } catch (e) { return send(res, 400, { error: e.message }); }
        delete options.out;
        const job = enqueue(options);
        return send(res, 202, { id: job.id });
      }

      // Capture a list of pages with one set of options. Body: the /api/snap options plus
      // urls: [...]. Nothing is queued unless every URL is valid; otherwise the answer lists
      // the bad ones as invalid: [{ index, url, error }].
      if (req.method === 'POST' && p === '/api/batch') {
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'The request must be JSON.' });
        const { urls, name: rawName, ...body } = await readJson(req);
        const name = typeof rawName === 'string' ? rawName.trim() : '';
        if (name.length > MAX_NAME) return send(res, 400, { error: `The list name must be ${MAX_NAME} characters or fewer.` });
        delete body.out;
        delete body.headed;
        delete body.url;
        const list = Array.isArray(urls) ? [...new Set(urls.map((u) => String(u ?? '').trim()).filter(Boolean))] : [];
        if (!list.length) return send(res, 400, { error: 'The list has no URLs.' });
        if (list.length > MAX_LIST) return send(res, 400, { error: `The list has ${list.length} URLs. The most is ${MAX_LIST}.` });
        const options = [];
        const invalid = [];
        list.forEach((url, index) => {
          try { options.push(normalize({ ...body, url, out: 'x' })); } catch (e) { invalid.push({ index, url, error: e.message }); }
        });
        if (invalid.length) {
          return send(res, 400, { error: `${invalid.length === 1 ? 'One URL is' : `${invalid.length} URLs are`} not valid.`, invalid });
        }
        const shared = { ...options[0] };
        delete shared.out;
        delete shared.url;
        const b = enqueueBatch(options.map((o) => o.url), shared, name);
        return send(res, 202, { id: b.id, jobs: b.jobs.map((j, i) => ({ id: j.id, url: options[i].url })) });
      }

      // Find the pages of a site for the list editor. Body: { site, under, mode, limit }.
      // Answers with one JSON object per line as it goes: { type: 'log', message },
      // { type: 'progress', found }, then { type: 'done', urls, source, truncated } or
      // { type: 'error', message }. Closing the request stops the search.
      if (req.method === 'POST' && p === '/api/find') {
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'The request must be JSON.' });
        const body = await readJson(req);
        const limit = body.limit === undefined ? MAX_LIST : Number(body.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST) return send(res, 400, { error: `The page limit must be a whole number from 1 to ${MAX_LIST}.` });
        const controller = new AbortController();
        let finished = false;
        res.on('close', () => { if (!finished) controller.abort(); });
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        const line = (o) => res.write(`${JSON.stringify(o)}\n`);
        let lastProgress = 0;
        try {
          const r = await findPages(body.site, {
            limit, under: body.under?.trim() || undefined, mode: body.mode || 'auto', signal: controller.signal,
            onLog: (message) => line({ type: 'log', message }),
            onProgress: ({ found }) => {
              if (Date.now() - lastProgress < 300) return;
              lastProgress = Date.now();
              line({ type: 'progress', found });
            },
          });
          line({ type: 'done', ...r });
        } catch (e) {
          if (!controller.signal.aborted) line({ type: 'error', message: e.message.split('\n')[0] });
        }
        finished = true;
        return res.end();
      }

      // Whether a list is still known (the UI asks after a reload): { id, ended }.
      const bs = p.match(/^\/api\/batches\/([0-9a-f-]{36})$/);
      if (bs && req.method === 'GET') {
        const b = batches.get(bs[1]);
        return b ? send(res, 200, { id: b.id, ended: b.jobs.every(ended) }) : send(res, 404, { error: 'This list is not known. It may have expired.' });
      }

      const bm = p.match(/^\/api\/batches\/([0-9a-f-]{36})\/(events|cancel|zip)$/);
      if (bm) {
        // The ZIP works after the list has expired from memory: its captures carry the list's id.
        if (bm[2] === 'zip' && req.method === 'GET') {
          const caps = (await listCaptures()).filter((c) => c.batch === bm[1]);
          const files = caps.flatMap((c) => c.files).map((f) => captureFile(encodeURIComponent(f))).filter(Boolean);
          if (!files.length) return send(res, 404, { error: 'This list has no saved captures.' });
          const first = Math.min(...caps.map((c) => c.createdAt));
          // "My pricing pages" → "my-pricing-pages-20261020-180340.zip"
          const named = ((await readLists())[bm[1]]?.name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
          res.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="${named || 'pagesnap-list'}-${stamp(new Date(first))}.zip"`,
            'Cache-Control': 'no-store',
          });
          await writeZip(res, files);
          return res.end();
        }
        const b = batches.get(bm[1]);
        if (!b) return send(res, 404, { error: 'This list is not known. It may have expired.' });
        if (bm[2] === 'cancel' && req.method === 'POST') {
          // Waiting jobs first, so none of them starts in a slot that a cancelled one frees.
          const order = [...b.jobs.filter((j) => j.status === 'queued'), ...b.jobs.filter((j) => j.status === 'running')];
          return send(res, 200, { cancelled: order.filter(cancel).length });
        }
        if (bm[2] === 'events' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
          for (const j of b.jobs) for (const e of j.events) if (e.type !== 'log') write(res, 'job', { id: j.id, type: e.type, data: e.data });
          if (b.jobs.every(ended)) { write(res, 'end', {}); return res.end(); }
          b.listeners.add(res);
          req.on('close', () => b.listeners.delete(res));
          return;
        }
      }

      const jm = p.match(/^\/api\/jobs\/([0-9a-f-]{36})\/(events|cancel)$/);
      if (jm) {
        const job = jobs.get(jm[1]);
        if (!job) return send(res, 404, { error: 'This capture job is not known. It may have expired.' });
        if (jm[2] === 'cancel' && req.method === 'POST') return send(res, 200, { ok: cancel(job) });
        if (jm[2] === 'events' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
          for (const e of job.events) write(res, e.type, e.data);
          if (['done', 'error', 'cancelled'].includes(job.status)) return res.end();
          job.listeners.add(res);
          req.on('close', () => job.listeners.delete(res));
          return;
        }
      }

      if (req.method === 'GET' && p === '/api/captures') return send(res, 200, await listCaptures());

      // The lists that captures came from: { [id]: { name, createdAt } }.
      if (req.method === 'GET' && p === '/api/lists') return send(res, 200, await readLists());

      // Rename a list. Body: { name } ('' gives it back its default name). Answers { id, name }.
      const lm = p.match(/^\/api\/lists\/([0-9a-f-]{36})$/);
      if (lm && req.method === 'PATCH') {
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'The request must be JSON.' });
        const { name: raw } = await readJson(req);
        if (typeof raw !== 'string') return send(res, 400, { error: 'Give the new name of the list.' });
        const name = raw.trim();
        if (name.length > MAX_NAME) return send(res, 400, { error: `The list name must be ${MAX_NAME} characters or fewer.` });
        const id = lm[1];
        const known = batches.has(id) || (await listCaptures()).some((c) => c.batch === id);
        if (!known) return send(res, 404, { error: 'This list was not found.' });
        await updateIndex((captures, lists) => { lists[id] = { createdAt: Date.now(), ...lists[id], name }; });
        return send(res, 200, { id, name });
      }

      // Delete several captures at once. Body: { ids: [...] }. Answers { deleted, missing }.
      if (req.method === 'POST' && p === '/api/captures/delete') {
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'The request must be JSON.' });
        const { ids } = await readJson(req);
        if (!Array.isArray(ids) || !ids.length || ids.some((x) => typeof x !== 'string')) return send(res, 400, { error: 'Give the names of the captures to delete.' });
        const unique = [...new Set(ids)];
        const deleted = await deleteCaptures(unique);
        log(`deleted ${deleted} ${deleted === 1 ? 'capture' : 'captures'}`);
        return send(res, 200, { deleted, missing: unique.length - deleted });
      }

      const zm = p.match(/^\/api\/captures\/([^/]+)\/zip$/);
      if (zm && req.method === 'GET') {
        let id;
        try { id = decodeURIComponent(zm[1]); } catch { return send(res, 400, { error: 'The capture name is not valid.' }); }
        const g = (await listCaptures()).find((c) => c.id === id);
        const files = g?.files.map((f) => captureFile(encodeURIComponent(f))).filter(Boolean);
        if (!files?.length) return send(res, 404, { error: 'The capture was not found.' });
        // "site-20261018-164428-01-header.png" → "site-20261018-164428.zip"
        const m = g.files[0].match(PART_RE);
        const zipName = `${m ? m[1] : path.basename(g.files[0], path.extname(g.files[0]))}.zip`.replace(/["\\\r\n]/g, '_');
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${zipName}"`,
          'Cache-Control': 'no-store',
        });
        await writeZip(res, files);
        return res.end();
      }

      // Frame a saved capture without loading the site again. Body: { frame, frameBg, every }.
      const rm = p.match(/^\/api\/captures\/([^/]+)\/frame$/);
      if (rm && req.method === 'POST') {
        let id;
        try { id = decodeURIComponent(rm[1]); } catch { return send(res, 400, { error: 'The capture name is not valid.' }); }
        const src = (await listCaptures()).find((c) => c.id === id);
        if (!src) return send(res, 404, { error: 'The capture was not found.' });
        const why = frameableProblem(src);
        if (why) return send(res, 400, { error: why });
        const body = await readJson(req);
        const frame = String(body.frame || 'auto').toLowerCase();
        const frameBg = String(body.frameBg || 'transparent').toLowerCase();
        if (frame === 'none' || !FRAMES.includes(frame)) return send(res, 400, { error: `The frame "${frame}" is not supported. Use auto, phone, tablet, laptop, or browser.` });
        if (!FRAME_BACKGROUNDS.includes(frameBg)) return send(res, 400, { error: `The frame background "${frameBg}" is not supported. Use transparent, light, dark, or gradient.` });
        const every = !!body.every;
        const so = src.options ?? {};
        // "Capture again" on the framed copy runs a live framed capture with the same settings.
        // Captures made outside the UI have no URL; then the framed copy has none either, and the
        // UI offers no "Capture again" for it.
        const options = { ...so, url: src.url, format: 'png', frame, frameBg, split: every ? 'screen' : 'none' };
        const job = enqueue(options, {
          extra: { source: src.id },
          run: (out, hooks) => {
            return reframe({
              files: src.files.map((f) => path.join(outDir, f)),
              out,
              url: src.url,
              device: so.device,
              viewport: so.device ? {} : { width: so.width, height: so.height },
              dpr: src.dpr ?? so.scale,
              frame, frameBg, every, dark: so.dark, keepScreens: true, frameTime: body.frameTime, frameDate: body.frameDate,
            }, hooks);
          },
        });
        return send(res, 202, { id: job.id });
      }

      const cm = p.match(/^\/api\/captures\/([^/]+)$/);
      if (cm && req.method === 'DELETE') {
        let id;
        try { id = decodeURIComponent(cm[1]); } catch { return send(res, 400, { error: 'The capture name is not valid.' }); }
        return (await deleteCapture(id)) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'The capture was not found.' });
      }

      // A framed capture's unframed screen, for the UI's live frame preview.
      const sm = p.match(/^\/frames\/([^/]+)\/(screen-\d{2,3}\.png)$/);
      if (sm && req.method === 'GET') {
        let rel;
        try { rel = `.frames/${decodeURIComponent(sm[1])}/${sm[2]}`; } catch { return send(res, 404, 'not found'); }
        const full = rawFile(rel);
        if (!full || !(await exists(full))) return send(res, 404, 'not found');
        const st = await fs.stat(full);
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': st.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return createReadStream(full).pipe(res);
      }

      // Change a framed capture's frame or background. Redraws its images in place from the
      // screens it kept. Body: { frame, frameBg }. Answers with the updated history entry.
      if (rm && req.method === 'PATCH') {
        let id;
        try { id = decodeURIComponent(rm[1]); } catch { return send(res, 400, { error: 'The capture name is not valid.' }); }
        const body = await readJson(req);
        const run = async () => {
          const c = (await listCaptures()).find((x) => x.id === id);
          if (!c) throw Object.assign(new Error('The capture was not found.'), { status: 404 });
          if (!c.screens?.length) throw Object.assign(new Error('This capture has no saved screens. Capture it again with a frame to change the frame later.'), { status: 400 });
          const frame = String(body.frame || c.options?.frame || 'auto').toLowerCase();
          const frameBg = String(body.frameBg || c.framing?.bg || 'transparent').toLowerCase();
          const screens = c.screens.map((sc, i) => ({ raw: rawFile(sc.raw), top: sc.top, out: captureFile(encodeURIComponent(c.files[i])) }));
          if (screens.some((sc) => !sc.raw || !sc.out)) throw Object.assign(new Error('Some saved screens of this capture are missing.'), { status: 400 });
          const t0 = Date.now();
          const { frame: kind, time, date } = await redrawFrames({ screens, framing: c.framing }, { frame, frameBg, frameTime: body.frameTime, frameDate: body.frameDate });
          const sizes = await Promise.all(screens.map((sc) => fs.stat(sc.out).then((st) => st.size, () => 0)));
          let entry;
          await updateIndex((index) => {
            const e = index[id];
            if (!e) return;
            e.frame = kind;
            e.framing = { ...e.framing, bg: frameBg, time, date };
            e.options = { ...e.options, frame, frameBg, frameTime: time, frameDate: date };
            e.size = sizes.reduce((a, b) => a + b, 0);
            e.updatedAt = Date.now();
            entry = e;
          });
          log(`redrew ${id} as ${kind} on ${frameBg} at ${time} in ${Date.now() - t0} ms`);
          return entry;
        };
        // One redraw at a time per capture: a second request waits for the first.
        const next = (redraws.get(id) ?? Promise.resolve()).catch(() => {}).then(run);
        redraws.set(id, next);
        try {
          return send(res, 200, await next);
        } catch (e) {
          return send(res, e.status || 500, { error: e.message });
        } finally {
          if (redraws.get(id) === next) redraws.delete(id);
        }
      }

      const fm = p.match(/^\/files\/([^/]+)$/);
      if (fm && req.method === 'GET') {
        const full = captureFile(fm[1]);
        if (!full || !(await exists(full))) return send(res, 404, 'not found');
        const st = await fs.stat(full);
        const download = url.searchParams.has('download');
        res.writeHead(200, {
          'Content-Type': TYPES[path.extname(full).toLowerCase()],
          'Content-Length': st.size,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          ...(download ? { 'Content-Disposition': `attachment; filename="${path.basename(full)}"` } : {}),
        });
        return createReadStream(full).pipe(res);
      }

      if (req.method === 'POST' && p === '/api/reveal') {
        const body = await readJson(req).catch(() => ({}));
        const full = body.file ? captureFile(encodeURIComponent(body.file)) : null;
        if (full && await exists(full)) openExternal(full, { select: true });
        else openExternal(outDir);
        return send(res, 200, { ok: true });
      }

      return send(res, 404, 'not found');
    } catch (e) {
      log('request error:', e.message);
      if (!res.headersSent) send(res, 500, { error: e.message });
      else res.end();
    }
  });

  const listen = (p) => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(p, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const wanted = port === undefined ? DEFAULT_PORT : Number(port);
  if (!Number.isInteger(wanted) || wanted < 0 || wanted > 65535) throw new Error('The port must be a number from 0 to 65535.');
  try {
    await listen(wanted);
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
    log(`Port ${wanted} is in use. Using a free port.`);
    await listen(0);
  }
  actualPort = server.address().port;

  const href = `http://localhost:${actualPort}/`;
  log(`Captures go to ${outDir}`);
  log(`The UI is at ${href}  (press Ctrl+C to stop)`);
  console.log(href);
  if (open) openExternal(href);

  process.once('SIGINT', () => { server.close(); process.exit(0); });
  return server;
}
