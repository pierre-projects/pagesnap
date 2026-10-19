// A tiny event bus, so modules that need each other's actions don't import each other.
//   'recapture'         (capture)  run this saved capture again with its options   → capture.js
//   'captures-changed'  ()         a capture was saved or deleted                  → history.js
//   'frame'             (capture, { frame, frameBg, every })  put it in a device frame → capture.js
//   'sidebar-frame'     ({ frame } | { frameBg })  the sidebar's frame changed  → result.js (live frame)

const handlers = new Map();

export function on(name, fn) {
  if (!handlers.has(name)) handlers.set(name, []);
  handlers.get(name).push(fn);
}

export function emit(name, ...args) {
  for (const fn of handlers.get(name) ?? []) fn(...args);
}
