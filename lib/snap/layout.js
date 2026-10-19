// Layout fixes before capture: reveal animations off, 100vh pinned, sticky bars shown once.

// stickyMode: once | hide | keep. extraHide: CSS selectors to hide.
export async function prepareLayout(page, stickyMode, extraHide) {
  await page.evaluate(({ stickyMode, extraHide }) => {
    const vh = window.innerHeight;
    const all = document.body ? document.body.querySelectorAll('*') : [];

    // Scroll-driven CSS animations (animation-timeline: view()/scroll()) tie an element's look to
    // where it sits on screen. Out of view they are often at opacity 0, so drop them and keep the
    // element's normal style.
    for (const el of all) {
      const tl = getComputedStyle(el).animationTimeline;
      if (tl && tl !== 'auto' && tl !== 'none') el.style.setProperty('animation', 'none', 'important');
    }

    // Elements sized with 100vh balloon when the capture stretches the viewport; pin them to pixels.
    for (const el of all) {
      const h = el.getBoundingClientRect().height;
      if (h > vh * 0.9 && h < vh * 1.1) {
        el.style.setProperty('height', `${h}px`, 'important');
        el.style.setProperty('min-height', `${h}px`, 'important');
        el.style.setProperty('max-height', `${h}px`, 'important');
      }
    }

    if (stickyMode !== 'keep') {
      for (const el of all) {
        const pos = getComputedStyle(el).position;
        if (pos !== 'fixed' && pos !== 'sticky') continue;
        const r = el.getBoundingClientRect();
        if (stickyMode === 'hide') {
          el.style.setProperty('display', 'none', 'important');
        } else if (pos === 'sticky') {
          el.style.setProperty('position', 'relative', 'important');
        } else if (r.top > vh / 2 || r.height > vh * 0.8 || r.width === 0) {
          // Bottom-anchored widgets (chat bubbles, banners) and full-screen overlays: drop them.
          el.style.setProperty('display', 'none', 'important');
        } else {
          // Top bars: render once at the top of the page instead of repeating/floating.
          // We're scrolled to 0 here, so absolute lands where fixed was.
          el.style.setProperty('position', 'absolute', 'important');
        }
      }
    }

    for (const sel of extraHide) {
      try { document.querySelectorAll(sel).forEach((el) => el.style.setProperty('display', 'none', 'important')); } catch {}
    }
  }, { stickyMode, extraHide });
}
