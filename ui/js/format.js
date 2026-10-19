// Text for numbers, times, URLs and captures. Pure functions, no DOM.

export const fmtSize = (b) => b < 1024 ? `${b} B` : b < 1048576 ? `${Math.round(b / 1024)} KB` : `${(b / 1048576).toFixed(1)} MB`;
export const fmtMs = (ms) => ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
export const fmtPx = (n) => `${Math.round(n).toLocaleString()} px`;

export function ago(t) {
  if (!t) return '';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
  return new Date(t).toLocaleDateString();
}

export function prettyUrl(u) {
  try {
    const x = new URL(u);
    if (x.protocol === 'file:') return decodeURIComponent(x.pathname.split('/').pop());
    return (x.host.replace(/^www\./, '') + (x.pathname === '/' ? '' : x.pathname) + x.search).replace(/\/$/, '');
  } catch { return u; }
}

export function viewportLabel(o) {
  if (!o) return '';
  if (o.device) return o.device;
  return `${o.width} × ${o.height}${o.scale > 1 ? ` @${o.scale}×` : ''}`;
}

// "4 sections", "12 screens": how a split capture is described in the meta line and History.
export const SPLIT_NOUN = { screen: 'screens', sections: 'sections', height: 'slices', elements: 'elements' };
export const partsText = (c) => (c.files.length < 2 ? null : `${c.files.length} ${SPLIT_NOUN[c.split] || 'parts'}`);

export const captureTitle = (c) => (c.url ? prettyUrl(c.url) : c.id);

// The time and date now, the way a phone status bar shows them: "9:41" (or "21:41" where clocks
// use 24 hours; no AM/PM) and "Sat Oct 18".
export function clockNow(d = new Date()) {
  const h24 = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle?.startsWith('h2');
  const h = h24 ? d.getHours() : (d.getHours() % 12 || 12);
  const time = `${h}:${String(d.getMinutes()).padStart(2, '0')}`;
  const date = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).replace(',', '');
  return { time, date };
}

const FRAME_LABEL = { phone: 'Phone frame', tablet: 'Tablet frame', laptop: 'Laptop frame', browser: 'Browser frame' };
export const frameText = (c) => FRAME_LABEL[c.frame] || null;
