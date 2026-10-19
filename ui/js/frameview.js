// Live device frames in the page: the same frames the server saves (lib/snap/frames.js, served
// as /js/frames.js), drawn here so a change of frame or background shows at once.
//
// Each frame goes in a shadow root, so its CSS (which styles bare img, svg, *) cannot touch the
// UI and the UI's CSS cannot touch it. The page's security policy allows no inline styles, so the
// frame CSS is a constructed stylesheet and inline styles are applied through the CSSOM.

import { frameMarkup, FRAME_CSS, autoFrame } from './frames.js';

export { autoFrame };

let sheet;
function frameSheet() {
  if (!sheet) {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(`${FRAME_CSS}\n:host { display: block; width: max-content; }`);
  }
  return sheet;
}

// An element showing screen `img` (a URL) inside a `kind` frame. opts: frameMarkup() options.
export function frameElement(kind, opts) {
  const host = document.createElement('div');
  host.className = 'livestage';
  const root = host.attachShadow({ mode: 'open' });
  root.adoptedStyleSheets = [frameSheet()];
  // style="…" in markup is blocked by the policy; keep it aside and set it through the CSSOM.
  root.innerHTML = frameMarkup(kind, opts).replace(/ style="([^"]*)"/g, ' data-css="$1"');
  for (const el of root.querySelectorAll('[data-css]')) {
    el.style.cssText = el.dataset.css;
    el.removeAttribute('data-css');
  }
  return host;
}

// The URL of a saved unframed screen (".frames/<capture>/screen-01.png" in the history entry).
export const screenUrl = (raw) => `/frames/${raw.split('/').slice(1).map(encodeURIComponent).join('/')}`;
