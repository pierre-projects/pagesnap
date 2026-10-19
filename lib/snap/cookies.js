// Cookie banners: click "Reject" (or "Accept"), then hide whatever consent UI is left.

import { sleep } from './util.js';

const REJECT_TEXT = /^\s*(reject( all)?( cookies)?|decline( all)?|deny( all)?|refuse( all)?|only (necessary|essential)( cookies)?|(use )?necessary( cookies)? only|essential( cookies)? only|continue without accepting|disagree)\s*$/i;
const ACCEPT_TEXT = /^\s*(accept( all)?( cookies)?|allow( all)?( cookies)?|i agree|agree( (and|&) (close|continue))?|got it|ok(ay)?|i understand|i accept|consent|yes,? i agree)\s*$/i;

const CONSENT_SELECTORS = [
  '#onetrust-banner-sdk', '#onetrust-consent-sdk', '#CybotCookiebotDialog', '#cookie-law-info-bar',
  '.cc-window', '.cookie-banner', '.cookie-consent', '#cookie-banner', '#cookieConsent',
  '#usercentrics-root', '#sp_message_container', '[id^="sp_message_container"]', '.fc-consent-root',
  '#qc-cmp2-container', '.qc-cmp2-container', '#didomi-host', '#truste-consent-track',
  '[aria-label*="cookie" i][role="dialog"]', '[class*="cookie-notice"]', '[id*="cookie-notice"]',
  '[class*="CookieBanner"]', '[class*="consent-banner"]', '[id*="consent-banner"]', '.osano-cm-window',
];

async function clickConsent(page, pattern) {
  for (const frame of page.frames()) {
    try {
      const btn = frame.getByRole('button', { name: pattern }).first();
      if (await btn.isVisible({ timeout: 300 })) {
        await btn.click({ timeout: 2000 });
        return true;
      }
      // Some banners use links or divs styled as buttons.
      const alt = frame.locator('a, [role="link"], div[tabindex], span[tabindex]').filter({ hasText: pattern }).first();
      if (await alt.isVisible({ timeout: 200 })) {
        await alt.click({ timeout: 2000 });
        return true;
      }
    } catch { /* detached frame or not clickable: keep looking */ }
  }
  return false;
}

// mode: reject | accept | hide | off
export async function handleCookies(page, mode, log) {
  if (mode === 'off') return;
  let clicked = false;
  if (mode === 'reject') clicked = (await clickConsent(page, REJECT_TEXT)) || (await clickConsent(page, ACCEPT_TEXT));
  if (mode === 'accept') clicked = await clickConsent(page, ACCEPT_TEXT);
  if (clicked) { log('Closed the cookie banner.'); await sleep(600); }
  // Whatever is left over gets hidden, and any scroll lock it put on the page is undone.
  await page.evaluate((sels) => {
    for (const sel of sels) {
      try { document.querySelectorAll(sel).forEach((el) => el.style.setProperty('display', 'none', 'important')); } catch {}
    }
    for (const el of [document.documentElement, document.body]) {
      if (!el) continue;
      const cs = getComputedStyle(el);
      if (cs.overflow === 'hidden' || cs.overflowY === 'hidden') el.style.setProperty('overflow', 'visible', 'important');
      if (cs.position === 'fixed') el.style.setProperty('position', 'static', 'important');
    }
  }, CONSENT_SELECTORS);
}
