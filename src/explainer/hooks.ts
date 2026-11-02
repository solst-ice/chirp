import { createContext, useEffect, useState, type RefObject } from 'react';

/** How much presentation mode enlarges the current slide (CSS zoom); 1 in the article. */
export const SlideZoom = createContext(1);

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
