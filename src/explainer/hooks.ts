import { createContext, useContext, useEffect, useRef, useState, type RefObject } from 'react';

/** How much presentation mode enlarges the current slide (CSS zoom); 1 in the article. */
export const SlideZoom = createContext(1);

/** A figure's steps, as presentation mode's keys see them. */
export interface SlideStepper {
  step: number;
  count: number;
  go: (n: number) => void;
}

/**
 * Set by presentation mode: the stepping figure on the current slide, if any.
 * The forward key reveals its next step before moving on to the next slide.
 * `atEnd` is set when going back, so the slide returns fully revealed.
 */
export interface SlideStepsRef {
  current: SlideStepper | null;
  atEnd: boolean;
}
export const SlideSteps = createContext<SlideStepsRef | null>(null);

/**
 * Steps on its own while on screen, until the reader takes over with BACK or
 * NEXT. With reduced motion it stands still on `restAt`: by default the last
 * step, which for a figure that builds up shows everything at once. While
 * presenting it waits on step one for the presenter, or on its last step when
 * the presenter came back to it.
 */
export function useStepper(count: number, ms: number, restAt = count - 1) {
  const ref = useRef<HTMLElement>(null);
  const visible = useVisible(ref);
  const reduced = useReducedMotion();
  const slideSteps = useContext(SlideSteps);
  const presenting = slideSteps !== null;
  const [manual, setManual] = useState<number | null>(() => (slideSteps?.atEnd ? count - 1 : null));
  const [base, setBase] = useState(0);
  const tick = useTicker(ms, visible && !reduced && !presenting && manual === null);
  const step = manual ?? (presenting ? 0 : reduced ? restAt : (tick - base) % count);
  const go = (n: number) => setManual(((n % count) + count) % count);
  /** Back to step one: autoplaying again, or waiting there for the presenter. */
  const reset = () => {
    setBase(tick);
    setManual(presenting ? 0 : null);
  };
  useEffect(() => {
    if (slideSteps) slideSteps.current = { step, count, go };
  });
  useEffect(
    () => () => {
      if (slideSteps) slideSteps.current = null;
    },
    [slideSteps],
  );
  return { ref, step, manual: manual !== null, go, reset };
}

/** True while the element is on screen; animations pause otherwise, leaving the main thread to the demodulators. */
export function useVisible(ref: RefObject<Element>): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return visible;
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

/** Advance a step counter every `ms` while `active`. */
export function useTicker(ms: number, active: boolean): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setTick((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms, active]);
  return tick;
}

export interface Palette {
  bg: string;
  fg: string;
  dim: string;
  line: string;
  sel: string;
  accent: string;
  rx: string;
  tx: string;
  warn: string;
  err: string;
}

let cached: Palette | null = null;

/** The app's colour tokens, for drawing on canvas. */
export function palette(): Palette {
  if (cached) return cached;
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(`--${name}`).trim();
  cached = {
    bg: v('bg'),
    fg: v('fg'),
    dim: v('dim'),
    line: v('line'),
    sel: v('sel'),
    accent: v('accent'),
    rx: v('rx'),
    tx: v('tx'),
    warn: v('warn'),
    err: v('err'),
  };
  return cached;
}
