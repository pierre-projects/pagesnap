// Per-browser memory of the form, the last URL and the theme. localStorage can be missing or
// blocked (private windows), so every access is wrapped and the UI works without it.

const KEY = 'pagesnap:ui:v2';

export function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
}

// Merge `changes` into what is saved.
export function patch(changes) {
  try { localStorage.setItem(KEY, JSON.stringify({ ...load(), ...changes })); } catch {}
}
