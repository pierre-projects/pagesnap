// Finding the pages of a site, to capture as a list: the site's sitemaps first, else a crawl of
// its links. Uses plain HTTP requests, which are fast; only a home page whose links are all
// added by JavaScript is opened in the browser.

import zlib from 'node:zlib';
import { normalize } from './options.js';
import { launch } from './browser.js';

// A browser user agent, so sites answer as they would to a visitor; "pagesnap" says who asks.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 pagesnap';
const TIMEOUT = 15000; // per request
const MAX_SITEMAPS = 50; // sitemap files read for one site
const MAX_DEPTH = 4; // links followed from the start page
const PARALLEL = 4; // requests at the same time while crawling
// Links to files, not pages.
const FILE_EXT = /\.(pdf|zip|gz|tgz|rar|7z|dmg|exe|msi|apk|jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|mp[34]|m4a|wav|ogg|webm|mov|avi|css|js|mjs|json|xml|rss|atom|txt|csv|xlsx?|docx?|pptx?|woff2?|ttf|otf|eot)$/i;
// Pages that change state or need an account: never worth a capture.
const SKIP_PATH = /\/(log-?out|sign-?out|log-?in|sign-?in|wp-admin|wp-login\.php|cart|checkout)(\/|$)/i;

export const FIND_MODES = ['auto', 'sitemap', 'crawl'];

const NET_ERRORS = {
  ENOTFOUND: 'The server name was not found. Check the URL.',
  EAI_AGAIN: 'The server name was not found. Check the URL.',
  ECONNREFUSED: 'The server refused the connection. Make sure that the server is running.',
  ECONNRESET: 'The server closed the connection.',
  CERT_HAS_EXPIRED: 'The site\'s security certificate has expired.',
};

const cancelled = () => new Error('Finding pages was cancelled.');

// Find the pages of `site` (a URL; a path in it, like example.com/docs, keeps only the pages
// under that path, as `under` does). mode: auto (sitemap, else crawl) | sitemap | crawl.
// Returns { urls, source: 'sitemap' | 'crawl', truncated } with at most `limit` URLs; truncated
// means the site has more. onProgress({ found, checked }) reports the count as it grows.
export async function findPages(site, { limit = 200, under, mode = 'auto', signal, onLog = () => {}, onProgress = () => {} } = {}) {
  if (!FIND_MODES.includes(mode)) throw new Error('The mode must be auto, sitemap, or crawl.');
  limit = Number(limit);
  if (!Number.isInteger(limit) || limit < 1) throw new Error('The page limit must be a whole number of 1 or more.');
  const start = siteUrl(site);
  // A page in the site URL ("/docs/index.html") stands for its folder.
  const prefix = pathPrefix(under ?? start.pathname.replace(/\/[^/]*\.[a-z0-9]+$/i, ''));
  const ctx = { start, prefix, implicitPrefix: under === undefined, limit, signal, log: onLog, progress: onProgress };
  ctx.robots = await readRobots(start.origin, ctx);

  if (mode !== 'crawl') {
    const r = await fromSitemaps(ctx);
    if (r.urls.length) {
      onLog(`Found ${pagesText(r)} in ${r.files} ${r.files === 1 ? 'sitemap' : 'sitemaps'}.`);
      return { urls: r.urls, source: 'sitemap', truncated: r.truncated };
    }
    const why = r.files ? `The sitemap has no pages${prefix !== '/' ? ` under ${prefix}` : ''}.` : 'The site has no sitemap.';
    if (mode === 'sitemap') throw new Error(`${why} Use crawl to follow the links on the site.`);
    onLog(`${why} Following the links on the site instead.`);
  }
  const r = await crawl(ctx);
  if (!r.urls.length) throw new Error(`No pages were found${prefix !== '/' ? ` under ${prefix}` : ''}. Check the URL.`);
  onLog(`Found ${pagesText(r)} by following links.`);
  return { urls: r.urls, source: 'crawl', truncated: r.truncated };
}

const pagesText = (r) => `${r.urls.length}${r.truncated ? '+' : ''} ${r.urls.length === 1 && !r.truncated ? 'page' : 'pages'}`;

// ---------- URLs ----------

function siteUrl(site) {
  // normalize() adds the scheme the same way a capture does (http for localhost).
  const u = new URL(normalize({ url: site, out: 'x' }).url);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Pages can be found on http and https sites only.');
  return u;
}

// "/docs/" or "docs" → "/docs"; "" or "/" → "/".
const pathPrefix = (p) => `/${String(p ?? '').trim().replace(/^\/+|\/+$/g, '')}`;

const bareHost = (h) => h.toLowerCase().replace(/^www\./, '');

// The URL of a page of this site that `href` points to, without its #fragment, or null.
// Crawled links also lose their ?query: "?sort=" and "?page=" copies would fill the list.
function pageUrl(href, base, ctx, { keepQuery = false } = {}) {
  let u;
  try { u = new URL(href, base); } catch { return null; }
  if (!['http:', 'https:'].includes(u.protocol) || bareHost(u.hostname) !== bareHost(ctx.start.hostname)) return null;
  if (u.port !== ctx.start.port) return null;
  u.hash = '';
  if (!keepQuery) u.search = '';
  if (FILE_EXT.test(u.pathname) || SKIP_PATH.test(u.pathname)) return null;
  if (ctx.prefix !== '/' && u.pathname !== ctx.prefix && !u.pathname.startsWith(`${ctx.prefix}/`)) return null;
  return u.href;
}

// "https://example.com/a/" and "http://www.example.com/a" are the same page.
const pageKey = (url) => {
  const u = new URL(url);
  return `${bareHost(u.hostname)}${u.port ? `:${u.port}` : ''}${u.pathname.replace(/\/+$/, '') || '/'}${u.search}`;
};

const decodeXml = (s) => s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e.toLowerCase()];
  if (named) return named;
  return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
});

// ---------- HTTP ----------

// GET `url`. Never throws for a network error: returns { ok: false, error } instead.
async function get(url, ctx) {
  if (ctx.signal?.aborted) throw cancelled();
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(), TIMEOUT);
  const stop = () => c.abort();
  ctx.signal?.addEventListener('abort', stop, { once: true });
  try {
    const res = await fetch(url, { signal: c.signal, headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } });
    let buf = Buffer.from(await res.arrayBuffer());
    // A .xml.gz sitemap comes as a gzip file, not as a compressed response.
    if (buf[0] === 0x1f && buf[1] === 0x8b) { try { buf = zlib.gunzipSync(buf); } catch {} }
    return { ok: res.ok, status: res.status, url: res.url || url, type: res.headers.get('content-type') ?? '', text: buf.toString('utf8') };
  } catch (e) {
    if (ctx.signal?.aborted) throw cancelled();
    const code = e.cause?.code;
    const message = c.signal.aborted ? 'The server did not reply in time.' : NET_ERRORS[code] ?? `The request failed${code ? ` (${code})` : ''}.`;
    return { ok: false, status: 0, url, error: message };
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener('abort', stop);
  }
}

// ---------- robots.txt ----------

// The sitemaps that robots.txt names, and whether it lets everyone ("*") visit a path.
async function readRobots(origin, ctx) {
  const res = await get(`${origin}/robots.txt`, ctx);
  const robots = { sitemaps: [], rules: [] };
  if (!res.ok || /html/i.test(res.type)) return robots;
  let agents = [];
  let inRules = false;
  for (const raw of res.text.split(/\r?\n/)) {
    const m = raw.replace(/#.*/, '').match(/^\s*([a-z-]+)\s*:\s*(.*?)\s*$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2];
    if (key === 'sitemap') { if (value) robots.sitemaps.push(value); continue; }
    if (key === 'user-agent') {
      if (inRules) { agents = []; inRules = false; }
      agents.push(value.toLowerCase());
      continue;
    }
    if (key !== 'allow' && key !== 'disallow') continue;
    inRules = true;
    if (!agents.includes('*') || !value) continue;
    // "*" matches anything, "$" the end of the path.
    const re = new RegExp(`^${value.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\$(?!$)/g, '\\$')}`);
    robots.rules.push({ allow: key === 'allow', len: value.length, re });
  }
  // The longest rule that matches wins; with none, the path is allowed.
  robots.allows = (path) => {
    let best = null;
    for (const r of robots.rules) if (r.re.test(path) && (!best || r.len > best.len || (r.len === best.len && r.allow))) best = r;
    return !best || best.allow;
  };
  return robots;
}

// ---------- sitemaps ----------

async function fromSitemaps(ctx) {
  const { origin } = ctx.start;
  // The sitemaps robots.txt names; else the usual places, until one is found.
  const usual = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`, `${origin}/wp-sitemap.xml`];
  let named = ctx.robots.sitemaps.length > 0;
  const queue = named ? [...ctx.robots.sitemaps] : [...usual];
  const seenFiles = new Set();
  const seen = new Set();
  const urls = [];
  let files = 0;
  let truncated = false;
  while (files < MAX_SITEMAPS) {
    // The sitemaps robots.txt names can be missing; then try the usual places too.
    if (!queue.length && named && !files) { named = false; queue.push(...usual); }
    if (!queue.length) break;
    const file = queue.shift();
    if (seenFiles.has(file)) continue;
    seenFiles.add(file);
    const res = await get(file, ctx);
    const isIndex = /<sitemapindex[\s>]/i.test(res.text ?? '');
    if (!res.ok || (!isIndex && !/<urlset[\s>]/i.test(res.text))) continue;
    files++;
    ctx.log(`Reading the sitemap ${file}`);
    // Once one usual place works, the others are copies of it.
    if (!named && !isIndex) queue.length = 0;
    const locs = [...res.text.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) => decodeXml(m[1]));
    if (isIndex) {
      if (!named) queue.length = 0;
      queue.push(...locs);
      continue;
    }
    for (const loc of locs) {
      const url = pageUrl(loc, origin, ctx, { keepQuery: true });
      if (!url || seen.has(pageKey(url))) continue;
      seen.add(pageKey(url));
      if (urls.length >= ctx.limit) { truncated = true; break; }
      urls.push(url);
    }
    ctx.progress({ found: urls.length, checked: files });
    if (truncated) break;
  }
  return { urls, files, truncated };
}

// ---------- crawl ----------

// The links in a page's HTML, resolved against its <base href> or its own URL.
function htmlLinks(html, pageHref) {
  const base = html.match(/<base\s[^>]*href\s*=\s*["']?([^"'\s>]+)/i)?.[1];
  let baseHref = pageHref;
  try { if (base) baseHref = new URL(base, pageHref).href; } catch {}
  const hrefs = [];
  for (const m of html.matchAll(/<a\s[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
    hrefs.push(decodeXml(m[1] ?? m[2] ?? m[3] ?? ''));
  }
  return { hrefs, baseHref };
}

// The links of a page after its scripts ran, for sites that build their links in JavaScript.
async function renderedLinks(url, ctx) {
  ctx.log('The start page has no links in its HTML. Opening it in the browser to read them.');
  const browser = await launch(normalize({ url, out: 'x' }), ctx.log);
  const stop = () => browser.close().catch(() => {});
  ctx.signal?.addEventListener('abort', stop, { once: true });
  try {
    const page = await browser.newPage({ userAgent: UA });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    return await page.$$eval('a[href]', (as) => as.map((a) => a.href));
  } catch (e) {
    if (ctx.signal?.aborted) throw cancelled();
    ctx.log(`The browser could not open the page: ${e.message.split('\n')[0]}`);
    return [];
  } finally {
    ctx.signal?.removeEventListener('abort', stop);
    await browser.close().catch(() => {});
  }
}

async function crawl(ctx) {
  const first = pageUrl(ctx.prefix === '/' ? ctx.start.href : new URL(ctx.prefix, ctx.start).href, ctx.start, ctx, { keepQuery: true })
    ?? ctx.start.href;
  const seen = new Set([pageKey(first)]);
  const queue = [{ url: first, depth: 0, order: 0 }];
  const pages = []; // { url, order }
  let order = 1;
  let checked = 0;
  let active = 0;
  let firstError = null;
  // Pages that turn out not to be HTML still cost a request, so stop well before checking everything.
  const maxRequests = ctx.limit * 3 + 20;

  const enqueue = (hrefs, base, depth) => {
    for (const href of hrefs) {
      const url = pageUrl(href, base, ctx);
      if (!url) continue;
      const key = pageKey(url);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!ctx.robots.allows(new URL(url).pathname)) continue;
      queue.push({ url, depth, order: order++ });
    }
  };

  const visit = async ({ url, depth, order: ord }) => {
    const res = await get(url, ctx);
    checked++;
    if (!res.ok || !/html/i.test(res.type)) {
      if (ord === 0) firstError = res.error ?? `The server sent HTTP ${res.status}.`;
      return;
    }
    // A redirect can lead to another site, or to a page that is already in the list.
    let final = pageUrl(res.url, res.url, ctx, { keepQuery: ord === 0 });
    if (!final && ord === 0 && ctx.implicitPrefix) {
      // The start page moved ("/en/learn" → "/learn"): keep the pages under where it is now.
      ctx.prefix = pathPrefix(new URL(res.url).pathname.replace(/\/[^/]*\.[a-z0-9]+$/i, ''));
      ctx.log(`The start page moved to ${res.url}. Keeping the pages under ${ctx.prefix}.`);
      final = pageUrl(res.url, res.url, ctx, { keepQuery: true });
    }
    if (!final) return;
    const key = pageKey(final);
    if (ord !== 0 && key !== pageKey(url) && seen.has(key)) return;
    seen.add(key);
    pages.push({ url: final, order: ord });
    ctx.progress({ found: pages.length, checked });
    if (depth >= MAX_DEPTH) return;
    const { hrefs, baseHref } = htmlLinks(res.text, res.url);
    const before = queue.length;
    enqueue(hrefs, baseHref, depth + 1);
    // No links at all in the HTML: the page builds them with JavaScript.
    if (ord === 0 && !hrefs.length && queue.length === before) enqueue(await renderedLinks(res.url, ctx), res.url, depth + 1);
  };

  await new Promise((resolve, reject) => {
    const pump = () => {
      if (ctx.signal?.aborted) { reject(cancelled()); return; }
      while (active < PARALLEL && queue.length && pages.length + active < ctx.limit && checked + active < maxRequests) {
        // Shallow pages first, so a capped list has the main pages.
        const item = queue.shift();
        active++;
        visit(item).then(() => { active--; pump(); }, reject);
      }
      if (!active) resolve();
    };
    pump();
  });
  if (!pages.length && firstError) throw new Error(`The site did not load. ${firstError}`);
  pages.sort((a, b) => a.order - b.order);
  return { urls: pages.map((p) => p.url).slice(0, ctx.limit), truncated: queue.length > 0 };
}
