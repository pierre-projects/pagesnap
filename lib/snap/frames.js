// Device frames: put a screen capture inside a phone, tablet, laptop, or browser window.
// Each frame is plain HTML/CSS (no image assets), rendered in a second page of the same browser
// at the capture's pixel density, so the screen inside the frame stays pixel-perfect.

export const FRAMES = ['none', 'auto', 'phone', 'tablet', 'laptop', 'browser'];
export const FRAME_BACKGROUNDS = ['transparent', 'light', 'dark', 'gradient'];

// The status bar clock (phone, tablet) and date (tablet). Apple's own screenshots show 9:41.
export const FRAME_TIME = '9:41';
export const FRAME_DATE = 'Tue Jan 9';
// Frames that draw a clock; the others have no status bar.
export const CLOCK_FRAMES = ['phone', 'tablet'];

// Safari's toolbars on top of the page viewport, in CSS px (iPhone 15 Pro: 54 + 659 + 139 = 852).
const PHONE_STATUS = 54;
const PHONE_BAR = 139;

const BACKGROUNDS = {
  transparent: 'transparent',
  light: '#eef0f3',
  dark: '#0e1013',
  gradient: 'linear-gradient(140deg, #c7d2fe 0%, #fbcfe8 52%, #fde68a 100%)',
};

// The frame that fits a viewport: phones under 600 px wide, tablets under 1100 px, laptops above.
// A device from the device list decides by its own "mobile" flag.
export function autoFrame(device, viewportWidth) {
  if (device) return device.isMobile ? (viewportWidth < 600 ? 'phone' : 'tablet') : 'laptop';
  return viewportWidth < 600 ? 'phone' : viewportWidth < 1100 ? 'tablet' : 'laptop';
}

// The color at the top of the viewport (what Safari tints its status bar with) and whether
// text on it should be light or dark. Runs in the captured page.
export function topColorInPage() {
  const parse = (c) => (c?.match(/[\d.]+/g) || []).map(Number);
  const meta = document.querySelector('meta[name="theme-color"]:not([media])')?.content;
  let color = null;
  for (let el = document.elementFromPoint(innerWidth / 2, 2); el; el = el.parentElement) {
    const bg = getComputedStyle(el).backgroundColor;
    const [, , , a = 1] = parse(bg);
    if (bg && bg !== 'transparent' && a > 0.5) { color = bg; break; }
  }
  color ||= getComputedStyle(document.body).backgroundColor;
  if (!color || color === 'rgba(0, 0, 0, 0)') color = 'rgb(255, 255, 255)';
  // A theme-color meta tag wins, the way Safari uses it, but only when the browser can read it.
  const probe = document.createElement('i');
  probe.style.color = meta || '';
  const metaColor = meta && probe.style.color ? meta : null;
  const swatch = document.createElement('i');
  swatch.style.color = metaColor || color;
  document.body.append(swatch);
  const [r, g, b] = parse(getComputedStyle(swatch).color);
  swatch.remove();
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return { color: metaColor || color, dark: lum < 0.55 };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- icons ----------
const I = {
  signal: '<svg width="18" height="12" viewBox="0 0 18 12"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="5.5" width="3" height="6.5" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></svg>',
  wifi: '<svg width="16" height="12" viewBox="0 0 16 12"><path d="M8 2.2c2.4 0 4.6.9 6.2 2.4l1.2-1.3C13.4 1.4 10.8.4 8 .4S2.6 1.4.6 3.3l1.2 1.3C3.4 3.1 5.6 2.2 8 2.2zm0 3.5c1.4 0 2.7.5 3.7 1.4l1.2-1.3C11.6 4.7 9.9 4 8 4s-3.6.7-4.9 1.8l1.2 1.3c1-.9 2.3-1.4 3.7-1.4zM8 9.2c-.6 0-1.2.2-1.6.6L8 11.6l1.6-1.8c-.4-.4-1-.6-1.6-.6z"/></svg>',
  battery: '<svg width="27" height="13" viewBox="0 0 27 13"><rect x="0.5" y="0.5" width="23" height="12" rx="3.5" fill="none" stroke="currentColor" opacity=".4"/><rect x="2" y="2" width="20" height="9" rx="2"/><path d="M25 4.5v4c.8-.3 1.3-1.1 1.3-2s-.5-1.7-1.3-2z" opacity=".45"/></svg>',
  lock: '<svg width="10" height="12" viewBox="0 0 10 12"><path d="M2 5V3.5a3 3 0 0 1 6 0V5h.5A1.5 1.5 0 0 1 10 6.5v4A1.5 1.5 0 0 1 8.5 12h-7A1.5 1.5 0 0 1 0 10.5v-4A1.5 1.5 0 0 1 1.5 5H2zm1.3 0h3.4V3.5a1.7 1.7 0 0 0-3.4 0V5z"/></svg>',
  reload: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg>',
  back: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
  fwd: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>',
  share: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M8 7l4-4 4 4M6 11H5v10h14V11h-1"/></svg>',
  book: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6c-2-1.5-5-2-8-1.5v14c3-.5 6 0 8 1.5 2-1.5 5-2 8-1.5v-14c-3-.5-6 0-8 1.5zM12 6v14"/></svg>',
  tabs: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="7" width="14" height="14" rx="3"/><path d="M7 7V6a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-1"/></svg>',
  sidebar: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/></svg>',
  plus: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
};

// ---------- pieces ----------
const statusIcons = `<span class="icons">${I.signal}${I.wifi}${I.battery}</span>`;

// macOS-style window bar: traffic lights, arrows, and the address field.
const windowBar = (host) => `
  <div class="winbar">
    <span class="lights"><i></i><i></i><i></i></span>
    <span class="nav">${I.back}${I.fwd}</span>
    <span class="addr">${I.lock}<b>${esc(host)}</b></span>
    <span class="nav end">${I.share}${I.plus}</span>
  </div>`;

function phone({ shot, w, h, host, top, time }) {
  const r = Math.round(w * 0.14);
  return `
  <div class="phone" style="--w:${w}px;--r:${r}px">
    <i class="key action"></i><i class="key volup"></i><i class="key voldown"></i><i class="key power"></i>
    <div class="screen">
      <div class="status ${top.dark ? 'on-dark' : 'on-light'}" style="background:${top.color}">
        <span class="time">${esc(time)}</span><span class="island"></span>${statusIcons}
      </div>
      ${shot}
      <div class="safari">
        <div class="pill"><span class="aa"><small>A</small>A</span><span class="host">${I.lock}${esc(host)}</span>${I.reload}</div>
        <div class="tools">${I.back}${I.fwd}${I.share}${I.book}${I.tabs}</div>
        <div class="homebar"><i></i></div>
      </div>
    </div>
  </div>`;
}

function tablet({ shot, w, h, host, top, time, date }) {
  return `
  <div class="tablet" style="--w:${w}px">
    <i class="cam"></i>
    <div class="screen">
      <div class="status ${top.dark ? 'on-dark' : 'on-light'}" style="background:${top.color}">
        <span class="time">${esc(time)}${date ? `&nbsp;&nbsp;${esc(date)}` : ''}</span>${statusIcons}
      </div>
      <div class="ipadbar">
        <span class="nav">${I.sidebar}${I.back}${I.fwd}</span>
        <span class="addr"><span class="aa"><small>A</small>A</span>${I.lock}<b>${esc(host)}</b>${I.reload}</span>
        <span class="nav end">${I.share}${I.plus}${I.tabs}</span>
      </div>
      ${shot}
    </div>
  </div>`;
}

function laptop({ shot, w, h, host }) {
  return `
  <div class="laptop" style="--w:${w}px">
    <div class="lid"><i class="cam"></i>
      <div class="screen">${windowBar(host)}${shot}</div>
    </div>
    <div class="base"><i></i></div>
  </div>`;
}

function browserWindow({ shot, w, h, host }) {
  return `
  <div class="window" style="--w:${w}px">
    ${windowBar(host)}
    ${shot}
  </div>`;
}

// The screen inside the frame: one image, or a window onto a stack of capture parts.
function screenHtml({ img, parts, offset, w, h }) {
  if (img) return `<img src="${img}" style="width:${w}px;height:${h}px">`;
  const strip = parts.map((src) => `<img src="${src}" style="width:${w}px">`).join('');
  return `<div class="shot" style="width:${w}px;height:${h}px"><div style="transform:translateY(-${offset}px)">${strip}</div></div>`;
}

const CSS = `
  * { box-sizing: border-box; margin: 0; }
  html, body { background: transparent; }
  body { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .stage { display: inline-block; padding: var(--pad); background: var(--bg); }
  img { display: block; }
  .shot { position: relative; overflow: hidden; background: #fff; }
  svg { display: block; fill: currentColor; flex: none; }

  /* chrome colors: light and dark appearance */
  .stage { --bar: #f6f6f8; --bar-line: rgba(0,0,0,.12); --field: rgba(118,118,128,.14); --ink: #1c1c1e; --ink-2: #6e6e73; --accent: #0a84ff; }
  .stage.dark { --bar: #1f1f22; --bar-line: rgba(255,255,255,.1); --field: rgba(118,118,128,.28); --ink: #f2f2f7; --ink-2: #98989f; --accent: #0a84ff; }

  /* ---------- phone ---------- */
  .phone { position: relative; padding: 12px; border-radius: calc(var(--r) + 12px);
    background: linear-gradient(145deg, #3b3b3f, #1b1b1d 40%, #2a2a2d);
    box-shadow: inset 0 0 0 1.5px #59595e, inset 0 0 0 5px #111, 0 2px 0 1px #0007, 0 40px 80px -20px rgba(0,0,0,.45), 0 18px 36px -18px rgba(0,0,0,.4); }
  .phone .key { position: absolute; width: 4px; border-radius: 2px; background: linear-gradient(90deg, #2c2c30, #4a4a4f); }
  .phone .action { left: -3px; top: 17%; height: 4.5%; }
  .phone .volup { left: -3px; top: 25%; height: 8%; }
  .phone .voldown { left: -3px; top: 35%; height: 8%; }
  .phone .power { right: -3px; top: 28%; height: 12%; }
  .phone .screen { width: var(--w); border-radius: var(--r); overflow: hidden; background: #000; position: relative; }
  .phone .status { height: ${PHONE_STATUS}px; position: relative; display: flex; align-items: center; justify-content: space-between; padding: 6px 30px 0 46px; }
  .phone .status .time { font-size: 17px; font-weight: 600; letter-spacing: -.2px; }
  .phone .island { position: absolute; top: 11px; left: 50%; width: 31.5%; height: 36px; transform: translateX(-50%); background: #000; border-radius: 20px; }
  .icons { display: flex; align-items: center; gap: 6px; }
  .on-light { color: #000; } .on-dark { color: #fff; }
  .phone .safari { height: ${PHONE_BAR}px; background: var(--bar); border-top: .5px solid var(--bar-line); color: var(--ink); display: flex; flex-direction: column; padding: 8px 12px 0; }
  .phone .pill { height: 46px; border-radius: 14px; background: var(--field); display: flex; align-items: center; justify-content: space-between; padding: 0 14px; color: var(--ink); }
  .aa { font-size: 17px; font-weight: 600; } .aa small { font-size: 12px; }
  .phone .host { display: flex; align-items: center; gap: 5px; font-size: 16px; font-weight: 500; }
  .phone .host svg { opacity: .55; }
  .phone .tools { display: flex; justify-content: space-around; align-items: center; height: 44px; margin-top: 4px; color: var(--accent); }
  .phone .tools svg:nth-child(2) { opacity: .35; }
  .phone .homebar { flex: 1; display: flex; align-items: flex-end; justify-content: center; padding-bottom: 8px; }
  .phone .homebar i { width: 36%; height: 5px; border-radius: 3px; background: var(--ink); }

  /* ---------- tablet ---------- */
  .tablet { position: relative; padding: 20px; border-radius: 40px;
    background: linear-gradient(145deg, #3a3a3e, #1c1c1e 45%, #2b2b2e);
    box-shadow: inset 0 0 0 1.5px #5a5a5f, inset 0 0 0 6px #111, 0 40px 90px -25px rgba(0,0,0,.45), 0 20px 40px -20px rgba(0,0,0,.4); }
  .tablet .cam { position: absolute; top: 8px; left: 50%; width: 6px; height: 6px; margin-left: -3px; border-radius: 50%; background: #0c0c10; box-shadow: inset 0 0 0 1.5px #26262c; }
  .tablet .screen { width: var(--w); border-radius: 20px; overflow: hidden; background: #000; }
  .tablet .status { height: 26px; display: flex; align-items: center; justify-content: space-between; padding: 2px 22px 0; font-size: 13px; font-weight: 600; }
  .tablet .ipadbar { height: 52px; background: var(--bar); border-bottom: .5px solid var(--bar-line); display: flex; align-items: center; justify-content: space-between; padding: 0 18px; color: var(--accent); }
  .tablet .addr { flex: 0 1 46%; height: 36px; border-radius: 11px; background: var(--field); display: flex; align-items: center; justify-content: center; gap: 6px; color: var(--ink); font-size: 15px; position: relative; }
  .tablet .addr .aa { position: absolute; left: 12px; } .tablet .addr > svg:last-child { position: absolute; right: 12px; }
  .tablet .addr b { font-weight: 500; } .tablet .addr > svg:first-of-type { opacity: .55; }
  .nav { display: flex; gap: 18px; align-items: center; } .nav.end { justify-content: flex-end; }

  /* ---------- window bar (laptop + browser) ---------- */
  .winbar { height: 44px; display: flex; align-items: center; gap: 16px; padding: 0 16px; background: var(--bar); border-bottom: 1px solid var(--bar-line); color: var(--ink-2); }
  .winbar .lights { display: flex; gap: 8px; } .winbar .lights i { width: 12px; height: 12px; border-radius: 50%; background: #ff5f57; box-shadow: inset 0 0 0 .5px #0002; }
  .winbar .lights i:nth-child(2) { background: #febc2e; } .winbar .lights i:nth-child(3) { background: #28c840; }
  .winbar .nav { gap: 10px; } .winbar .nav svg { width: 18px; height: 18px; }
  .winbar .nav svg:nth-child(2) { opacity: .4; }
  .winbar .addr { flex: 1; max-width: 560px; margin: 0 auto; height: 30px; border-radius: 8px; background: var(--field); display: flex; align-items: center; justify-content: center; gap: 7px; color: var(--ink); font-size: 13px; }
  .winbar .addr b { font-weight: 500; } .winbar .addr svg { opacity: .5; }
  .winbar .nav.end { margin-left: 0; }

  /* ---------- laptop ---------- */
  .laptop { display: flex; flex-direction: column; align-items: center; filter: drop-shadow(0 40px 50px rgba(0,0,0,.28)); }
  .laptop .lid { position: relative; padding: 26px 18px 20px; border-radius: 22px 22px 6px 6px; background: #0b0b0d;
    box-shadow: inset 0 0 0 2px #2c2c30, 0 0 0 2px #b9bbc1, 0 0 0 3px #8d8f95; }
  .laptop .cam { position: absolute; top: 10px; left: 50%; width: 7px; height: 7px; margin-left: -3.5px; border-radius: 50%; background: #1a1a20; box-shadow: inset 0 0 0 1.5px #2c2c34; }
  .laptop .screen { width: var(--w); overflow: hidden; border-radius: 4px; background: #000; }
  .laptop .base { position: relative; width: calc(var(--w) * 1.16 + 36px); height: 22px; margin-top: 3px;
    background: linear-gradient(180deg, #e6e7ea 0%, #c9cbcf 45%, #9fa1a7 100%); border-radius: 2px 2px 18px 18px / 2px 2px 14px 14px;
    box-shadow: inset 0 1px 0 #fff9, inset 0 -2px 3px #0002; }
  .laptop .base i { position: absolute; top: 0; left: 50%; width: 15%; height: 9px; transform: translateX(-50%); border-radius: 0 0 10px 10px;
    background: linear-gradient(180deg, #a9abb0, #c8cace); box-shadow: inset 0 -1px 2px #0003; }

  /* ---------- browser window ---------- */
  .window { width: var(--w); border-radius: 12px; overflow: hidden; background: var(--bar);
    box-shadow: 0 0 0 1px rgba(0,0,0,.14), 0 50px 100px -30px rgba(0,0,0,.45), 0 25px 50px -25px rgba(0,0,0,.4); }
  .stage.dark .window { box-shadow: 0 0 0 1px rgba(255,255,255,.12), 0 50px 100px -30px rgba(0,0,0,.6); }
`;

// The frame CSS. It styles bare elements (img, svg, *), so the UI puts it in a shadow root.
export const FRAME_CSS = CSS;

// The `.stage` element: a w × h CSS px screen inside a `kind` frame. The screen is either `img`
// (the URL of exactly one screen) or `parts`: the images of an earlier capture, stacked top to
// bottom at width w, seen through the screen from `offset` px down.
// `top` = topColorInPage() of that screen; `dark` = dark browser chrome; `bg` = stage background;
// `time` and `date` = the status bar clock (phone, tablet) and date (tablet; '' hides it).
// This module has no Node dependencies, so the web UI imports it too and draws the same frames.
export function frameMarkup(kind, { img, parts, offset = 0, w, h, host, top, dark, bg, time = FRAME_TIME, date = FRAME_DATE }) {
  const shot = screenHtml({ img, parts, offset, w, h });
  const body = { phone, tablet, laptop, browser: browserWindow }[kind]({ shot, w, h, host, top, time, date });
  const pad = kind === 'laptop' ? Math.round(w * 0.08 + 56) : kind === 'browser' ? 72 : 64;
  return `<div class="stage ${dark ? 'dark' : ''}" style="--pad:${pad}px;--bg:${BACKGROUNDS[bg] || 'transparent'}">${body}</div>`;
}

// A full HTML page around frameMarkup(), for rendering to an image.
export function frameHtml(kind, opts) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head>
<body>${frameMarkup(kind, opts)}</body></html>`;
}

// What a framed screen holds besides the page itself: the phone adds Safari's status bar and
// bottom toolbar, the tablet its status bar and top toolbar, and so on. Used for log messages.
export const FRAME_NAMES = { phone: 'phone', tablet: 'tablet', laptop: 'laptop', browser: 'browser window' };
