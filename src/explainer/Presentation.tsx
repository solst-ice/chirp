import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SlideZoom } from './hooks';
import { stopSound } from './sound';

export interface Slide {
  id: string;
  /** Announced on each change, e.g. "Hearing it: the FFT". */
  title: string;
  content: React.ReactNode;
}

const MAX_ZOOM = 3;
/**
 * The article's column (76ch plus padding) in px. Not in ch: ch comes from the
 * zoomed font, whose rounding would make the width, and so the fit, depend on the zoom.
 */
const SLIDE_WIDTH = 640;
/** Below 1 only on desktop-sized windows (not phones, either way up), e.g. a tall slide on a 720p projector. */
const MIN_ZOOM = 0.75;

/**
 * The article as slides filling the window, one block at a time. Each slide is laid
 * out at the article's own column width, then zoomed to fill the window (on a
 * phone a tall slide scrolls instead of shrinking).
 */
export default function Presentation({
  slides,
  index,
  onIndex,
  onExit,
}: {
  slides: Slide[];
  index: number;
  onIndex: (index: number) => void;
  onExit: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const slideRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  /** Upper bound for this slide, lowered when a zoom that should fit doesn't. */
  const cap = useRef(MAX_ZOOM);
  const floor = useRef(1);
  const last = slides.length - 1;
  const go = (n: number) => onIndex(Math.max(0, Math.min(last, n)));

  // The article behind keeps still and drops its scrollbar. Before the fit
  // below, so the fit measures the window without that scrollbar.
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.style.overflow = 'hidden';
    return () => {
      root.style.overflow = '';
    };
  }, []);

  // Fit the slide to the window: as large as both dimensions allow. A new slide
  // or a resized window fits from scratch. After that, changes in the slide's
  // own size (text re-wrapping at the new zoom, a figure being used) can only
  // lower the zoom: if they could raise it too, a slide whose size depends on
  // its zoom could flip between two zooms forever.
  useLayoutEffect(() => {
    const view = viewRef.current;
    const slide = slideRef.current;
    if (!view || !slide) return;
    const fit = (fresh: boolean) => {
      if (fresh) cap.current = MAX_ZOOM;
      // The view's content box: clientWidth/Height include its padding.
      const pad = getComputedStyle(view);
      const width = view.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight);
      const height = view.clientHeight - parseFloat(pad.paddingTop) - parseFloat(pad.paddingBottom);
      // offsetHeight is in the slide's own, unzoomed units. On a phone the slide
      // stays at 1 (squeezed to fit when narrower) and scrolls instead of shrinking.
      floor.current = width >= SLIDE_WIDTH && height >= 600 ? MIN_ZOOM : 1;
      const scale = Math.min(width / SLIDE_WIDTH, height / slide.offsetHeight);
      const next = Math.max(floor.current, Math.min(cap.current, Math.floor(scale * 20) / 20));
      setZoom((z) => {
        const target = fresh ? next : Math.min(z, next);
        return Math.abs(z - target) < 0.01 ? z : target;
      });
    };
    fit(true);
    const ro = new ResizeObserver(() => fit(false));
    ro.observe(slide);
    // The window, not the view: a scrollbar appearing in the view must not count as a resize.
    const onResize = () => fit(true);
    window.addEventListener('resize', onResize);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', onResize);
    };
  }, [index]);

  // Zoom isn't a pure magnification: text is laid out again at the zoomed size
  // and can wrap onto an extra line. If the zoomed slide overflows, step down
  // and cap the slide there, so a resize can't push it back up.
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view || zoom <= floor.current) return;
    if (view.scrollHeight > view.clientHeight + 1 || view.scrollWidth > view.clientWidth + 1) {
      cap.current = Math.max(floor.current, Math.round((zoom - 0.05) * 20) / 20);
      setZoom(cap.current);
    }
  }, [zoom, index]);

  // A demo started on one slide stops when you move on.
  useEffect(() => () => stopSound(), [index]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.isComposing) return;
      // Escape leaves from anywhere, a text field or slider included.
      if (e.key === 'Escape') {
        e.preventDefault();
        onExit();
        return;
      }
      // Sliders and text fields keep their own arrow keys.
      if ((e.target as HTMLElement).closest?.('input, textarea, select')) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') go(index + 1);
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') go(index - 1);
      else if (e.key === 'Home') go(0);
      else if (e.key === 'End') go(last);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => rootRef.current?.focus(), []);

  const slide = slides[index];
  return (
    <div className="ex-present" ref={rootRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="How chirp works, presentation">
      <div className="ex-present-view" ref={viewRef}>
        <div className="explainer ex-slide" ref={slideRef} style={{ zoom, width: SLIDE_WIDTH }} key={slide.id}>
          <SlideZoom.Provider value={zoom}>{slide.content}</SlideZoom.Provider>
        </div>
      </div>
      <nav className="ex-present-bar" aria-label="Slides">
        <button className="btn" onClick={() => go(index - 1)} disabled={index === 0} aria-label="Previous slide">
          [ ← ]
        </button>
        <span className="ex-present-count" aria-live="polite">
          {index + 1} / {slides.length}
          <span className="sr-only">: {slide.title}</span>
        </span>
        <button className="btn" onClick={() => go(index + 1)} disabled={index === last} aria-label="Next slide">
          [ → ]
        </button>
        <button className="btn ex-present-exit" onClick={onExit}>
          [ <span className="key-hint">ESC </span>EXIT ]
        </button>
      </nav>
    </div>
  );
}
