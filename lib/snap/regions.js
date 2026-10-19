// Split regions: which parts of the page each split mode captures, as { x?, y, width?, height, label }
// boxes in CSS px. The *InPage functions run inside the browser via page.evaluate().

// Bands that follow the page's own layout: header, hero, each section, footer. Runs in the page.
function findSectionsInPage() {
  const se = document.scrollingElement || document.documentElement;
  const pageH = se.scrollHeight;
  const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE']);
  const h = (el) => el.getBoundingClientRect().height;
  const shown = (el) => {
    if (SKIP.has(el.tagName)) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const kids = (el) => [...el.children].filter(shown);

  // Go down through wrappers (#root, #__next, a page div) that hold the whole page.
  let node = document.body;
  for (let depth = 0; depth < 10; depth++) {
    const big = kids(node).filter((k) => h(k) >= 40);
    if (big.length === 1 && h(big[0]) >= h(node) * 0.9) node = big[0];
    else break;
  }
  // <main>, and any block over two screens tall, is a container, not a section: open it up.
  const vh = window.innerHeight;
  const big = (el) => kids(el).filter((c) => h(c) >= 40);
  const expand = (el, depth) => {
    const container = el.tagName === 'MAIN' || el.getAttribute('role') === 'main' || h(el) > vh * 2;
    if (!container || depth > 6) return [el];
    let inner = big(el);
    // Skip wrappers with a single child that fills them.
    let guard = 0;
    while (inner.length === 1 && h(inner[0]) >= h(el) * 0.9 && guard++ < 12) { el = inner[0]; inner = big(el); }
    if (inner.length < 2) return [el];
    // Side-by-side columns (a sidebar and the article): follow the largest one down.
    const sorted = [...inner].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    const sideBySide = sorted.some((c, i) => i > 0 && c.getBoundingClientRect().top < sorted[i - 1].getBoundingClientRect().bottom - 10);
    if (sideBySide) {
      const area = (c) => { const r = c.getBoundingClientRect(); return r.width * r.height; };
      return expand(inner.reduce((a, b) => (area(b) > area(a) ? b : a)), depth + 1);
    }
    return inner.flatMap((c) => expand(c, depth + 1));
  };
  const blocks = kids(node).flatMap((k) => expand(k, 0));

  const name = (el) => {
    if (/^(HEADER|FOOTER|NAV)$/.test(el.tagName)) return el.tagName.toLowerCase();
    const aria = el.getAttribute('aria-label');
    if (aria) return aria;
    const head = el.querySelector('h1, h2, h3');
    const text = head?.textContent.replace(/\s+/g, ' ').trim();
    if (text) return text.slice(0, 60);
    // Only plain-word ids ("pricing", "main-content"), not generated ones ("mwAQ", "r1a2b3").
    if (/^[a-z]{3,}([-_][a-z]+)*$/.test(el.id)) return el.id.replace(/[-_]+/g, ' ');
    // A bare <div> or <tr> says nothing; the UI shows "Part N" for an empty name.
    return /^(SECTION|ARTICLE|ASIDE)$/.test(el.tagName) ? el.tagName.toLowerCase() : '';
  };

  const bands = blocks
    .map((el) => {
      const r = el.getBoundingClientRect();
      return { y: Math.max(0, r.top + scrollY), bottom: Math.min(pageH, r.bottom + scrollY), label: name(el) };
    })
    .filter((b) => b.bottom - b.y >= 40)
    .sort((a, b) => a.y - b.y);

  // Sections are cut lines, so together the parts cover the whole page: each part starts where
  // the last one ended (a title in a gap between blocks goes with the next block, and a header
  // laid over the hero is not captured twice), and the last part runs to the bottom.
  const out = [];
  let end = 0;
  for (const b of bands) {
    if (b.bottom - end < 40) continue;
    out.push({ y: end, height: b.bottom - end, label: b.label });
    end = b.bottom;
  }
  if (out.length && pageH - end > 0) {
    if (pageH - end < 40) out[out.length - 1].height += pageH - end;
    else out.push({ y: end, height: pageH - end, label: 'end of page' });
  }
  return out;
}

// One box per visible element that matches each selector. Runs in the page.
function findElementsInPage(selectors) {
  const regions = [];
  for (const sel of selectors) {
    let list;
    try { list = document.querySelectorAll(sel); } catch { return { bad: sel }; }
    let n = 0;
    for (const el of list) {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (cs.display === 'none' || cs.visibility === 'hidden' || r.width < 1 || r.height < 1) continue;
      n++;
      const head = el.querySelector('h1, h2, h3, h4')?.textContent.replace(/\s+/g, ' ').trim();
      regions.push({
        x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height,
        label: (head || el.getAttribute('aria-label') || `${sel} ${n}`).slice(0, 60),
      });
    }
  }
  return { regions };
}

// Cut lines for slices of at most `step` px that land in gaps between content, not through it.
// Runs in the page. Each cut can move up (never down, so no slice grows past `step`) by up to a
// quarter of a slice. Rows are scored per pixel:
//   hard  inside a text line, image, SVG, video, canvas, iframe, or form control: never cut here
//   soft  inside a card-like box (background, border or shadow) or a paragraph: avoid if possible
// The cut goes in the middle of the longest run of best-scoring rows, so slices get some margin.
// With no hard-free row in reach (a huge hero image), the cut stays at `step`.
function findCutsInPage({ step, height }) {
  const H = Math.ceil(height);
  const hard = new Int32Array(H + 2);
  const soft = new Int32Array(H + 2);
  // Mark rows strictly inside (top, bottom): cutting at row y splits rows y-1 and y.
  const mark = (arr, top, bottom) => {
    const a = Math.max(1, Math.floor(top) + 1);
    const b = Math.min(H, Math.ceil(bottom));
    if (b > a) { arr[a]++; arr[b]--; }
  };
  const sy = scrollY;

  // Text, line by line.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  const range = document.createRange();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    range.selectNodeContents(n);
    for (const r of range.getClientRects()) if (r.height > 0 && r.width > 0) mark(hard, r.top + sy, r.bottom + sy);
  }

  const MEDIA = 'img, svg, video, canvas, iframe, picture, input, button, select, textarea, [role="img"]';
  const BLOCK_TEXT = /^(P|LI|H[1-6]|BLOCKQUOTE|PRE|FIGURE|TR|DT|DD)$/;
  for (const el of document.body.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.height < 1 || r.width < 1) continue;
    if (el.matches(MEDIA)) { mark(hard, r.top + sy, r.bottom + sy); continue; }
    if (r.height > step * 1.5) continue; // page-sized wrappers say nothing about where to cut
    if (BLOCK_TEXT.test(el.tagName)) { mark(soft, r.top + sy, r.bottom + sy); continue; }
    const cs = getComputedStyle(el);
    const bg = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent';
    const border = parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none';
    const shadow = cs.boxShadow !== 'none';
    if (bg || border || shadow || cs.backgroundImage !== 'none') mark(soft, r.top + sy, r.bottom + sy);
  }
  for (let y = 1; y <= H; y++) { hard[y] += hard[y - 1]; soft[y] += soft[y - 1]; }

  const maxShift = Math.round(step * 0.25);
  const cuts = [];
  let start = 0;
  while (start + step < H) {
    const target = start + step;
    const lo = Math.max(start + 1, target - maxShift);
    let best = Infinity;
    for (let y = lo; y <= target; y++) if (!hard[y]) best = Math.min(best, soft[y]);
    let cut = target;
    if (best !== Infinity) {
      // Longest run of rows with the best score; on a tie, the one nearer the target.
      let runStart = -1;
      let bestRun = null;
      for (let y = lo; y <= target + 1; y++) {
        const ok = y <= target && !hard[y] && soft[y] === best;
        if (ok && runStart < 0) runStart = y;
        if (!ok && runStart >= 0) {
          const len = y - runStart;
          if (!bestRun || len >= bestRun.len) bestRun = { start: runStart, len };
          runStart = -1;
        }
      }
      cut = bestRun.start + Math.floor(bestRun.len / 2);
    }
    cuts.push(cut);
    start = cut;
  }
  // A last sliver (a footer's bottom edge) joins the slice above when that still fits in `step`.
  if (cuts.length && H - cuts[cuts.length - 1] < step * 0.15) {
    const prev = cuts.length > 1 ? cuts[cuts.length - 2] : 0;
    if (H - prev <= step * 1.15) cuts.pop();
  }
  return cuts;
}

// Bands of at most `step` px from the top of the page to the bottom, cut in the gaps between
// content. `exact` keeps every band exactly `step` px (the old behavior).
async function bands(page, height, step, { exact = false } = {}) {
  const cuts = [];
  if (exact) for (let y = step; y < height; y += step) cuts.push(y);
  else cuts.push(...await page.evaluate(findCutsInPage, { step, height }));
  const edges = [0, ...cuts, height];
  return edges.slice(0, -1).map((y, i) => ({ y, height: edges[i + 1] - y, label: '' }));
}

// The regions for o.split on a page of `width` × `height` CSS px.
export async function findRegions(page, o, { width, height }, log) {
  const opts = { exact: o.exactCuts };
  const screen = async () => bands(page, height, await page.evaluate(() => window.innerHeight), opts);
  switch (o.split) {
    case 'screen':
      return screen();
    case 'height': {
      const step = o.sliceHeight === 'a4' ? Math.round(width * 297 / 210)
        : o.sliceHeight === 'letter' ? Math.round(width * 11 / 8.5) : o.sliceHeight;
      return bands(page, height, step, opts);
    }
    case 'sections': {
      const found = await page.evaluate(findSectionsInPage);
      if (found.length) return found;
      log('No sections were found on the page. Using screen-sized slices.');
      return screen();
    }
    case 'elements': {
      const found = await page.evaluate(findElementsInPage, o.parts);
      if (found.bad) throw new Error(`The selector "${found.bad}" is not valid CSS.`);
      if (!found.regions.length) throw new Error(`No visible element matches ${o.parts.map((s) => `"${s}"`).join(', ')}.`);
      return found.regions;
    }
    default:
      return [{ y: 0, height, label: '' }];
  }
}
