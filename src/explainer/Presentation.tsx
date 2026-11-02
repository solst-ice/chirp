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
 * The article as full-screen slides, one block at a time. Each slide is laid
 * out at the article's own column width, then enlarged with CSS zoom to fill
 * the window (never shrunk: on a phone a tall slide scrolls instead).
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
  const last = slides.length - 1;
  const go = (n: number) => onIndex(Math.max(0, Math.min(last, n)));

  // Fit the slide to the window: as large as both dimensions allow. offsetWidth
  // and offsetHeight ignore the slide's own zoom, so this doesn't feed back on itself.
  useLayoutEffect(() => {
    const view = viewRef.current;
    const slide = slideRef.current;
    if (!view || !slide) return;
    const fit = () => {
      // The view's content box: clientWidth/Height include its padding.
      const pad = getComputedStyle(view);
      const width = view.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight);
      const height = view.clientHeight - parseFloat(pad.paddingTop) - parseFloat(pad.paddingBottom);
      const scale = Math.min(width / slide.offsetWidth, height / slide.offsetHeight);
      const next = Math.max(1, Math.min(MAX_ZOOM, Math.floor(scale * 20) / 20));
      setZoom((z) => (Math.abs(z - next) < 0.01 ? z : next));
    };
    fit();
    // Figures change height as they're used (typing, stepping), and windows resize.
    const ro = new ResizeObserver(fit);
    ro.observe(slide);
    ro.observe(view);
    return () => ro.disconnect();
  }, [index]);

  // A demo started on one slide stops when you move on.
  useEffect(() => () => stopSound(), [index]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      // Sliders and text fields keep their own arrow keys.
      if ((e.target as HTMLElement).closest?.('input, textarea, select')) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') go(index + 1);
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') go(index - 1);
      else if (e.key === 'Home') go(0);
      else if (e.key === 'End') go(last);
      else if (e.key === 'Escape') onExit();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Leaving full screen (the browser's own Esc) also leaves the presentation.
  const exitRef = useRef(onExit);
  exitRef.current = onExit;
  useEffect(() => {
    rootRef.current?.focus();
    const onChange = () => {
      if (!document.fullscreenElement) exitRef.current();
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const slide = slides[index];
  return (
    <div className="ex-present" ref={rootRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="How chirp works, presentation">
      <div className="ex-present-view" ref={viewRef}>
        <div className="explainer ex-slide" ref={slideRef} style={{ zoom }} key={slide.id}>
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
