// Lazy loading and infinite scroll: scroll the whole page so everything loads, then go back up.

import { sleep } from './util.js';

// progress({ y, height }) reports how far down the page the scroll is.
export async function scrollThrough(page, maxHeight, maxScrolls, log, progress) {
  await page.evaluate(() => {
    document.querySelectorAll('img[loading="lazy"], iframe[loading="lazy"]').forEach((el) => { el.loading = 'eager'; });
    // "scroll-behavior: smooth" would animate every scroll below, so the page would not be where
    // the code thinks it is when it measures or captures.
    for (const el of [document.documentElement, document.body]) el?.style.setProperty('scroll-behavior', 'auto', 'important');
  });
  let lastHeight = 0;
  let stableSteps = 0;
  let steps = 0;
  for (; steps < maxScrolls; steps++) {
    const { y, height, vh } = await page.evaluate(() => {
      const se = document.scrollingElement || document.documentElement;
      window.scrollBy(0, Math.round(window.innerHeight * 0.85));
      return { y: se.scrollTop, height: se.scrollHeight, vh: window.innerHeight };
    });
    await sleep(250);
    const atBottom = y + vh >= height - 2;
    progress({ y: Math.min(y + vh, height), height });
    if (height >= maxHeight) { log(`Stopped scrolling at the maximum height (${maxHeight} px).`); break; }
    if (atBottom) {
      // Give infinite-scroll pages a moment to append content before deciding we're done.
      await page.waitForLoadState('networkidle', { timeout: 1500 }).catch(() => {});
      const newHeight = await page.evaluate(() => (document.scrollingElement || document.documentElement).scrollHeight);
      if (newHeight === lastHeight || newHeight === height) stableSteps++;
      else stableSteps = 0;
      if (stableSteps >= 2) break;
    }
    lastHeight = height;
  }
  if (steps >= maxScrolls) log(`Stopped scrolling after the maximum number of scroll steps (${maxScrolls}).`);

  await page.evaluate(() => window.scrollTo(0, 0));
  // Wait for images that started loading during the scroll.
  await page.evaluate(async () => {
    const pending = [...document.images].filter((img) => !img.complete && img.src);
    await Promise.race([
      Promise.all(pending.map((img) => new Promise((r) => { img.onload = img.onerror = r; }))),
      new Promise((r) => setTimeout(r, 8000)),
    ]);
  });
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
}
