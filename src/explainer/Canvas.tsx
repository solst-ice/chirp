import { useEffect, useRef, useState } from 'react';
import { useReducedMotion, useVisible } from './hooks';

export type Draw = (ctx: CanvasRenderingContext2D, width: number, height: number, ms: number) => void;

interface Props {
  height: number;
  label: string;
  draw: Draw;
  /** Redraw every frame while on screen. Otherwise draws once per change of `redraw`. */
  animate?: boolean;
  redraw?: unknown;
}

/** A crisp, full-width canvas that only animates while visible and motion is allowed. */
export default function Canvas({ height, label, draw, animate = false, redraw }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const visible = useVisible(ref);
  const reduced = useReducedMotion();
  const [width, setWidth] = useState(0);
  const drawRef = useRef(draw);
  drawRef.current = draw;
  const startRef = useRef(performance.now());

  useEffect(() => {
    const parent = ref.current?.parentElement;
    if (!parent) return;
    const ro = new ResizeObserver(() => setWidth(parent.clientWidth));
    ro.observe(parent);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !width || !visible) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const paint = (ms: number) => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.font = '16px Unifont, monospace';
      ctx.textBaseline = 'top';
      drawRef.current(ctx, width, height, ms);
    };
    if (!animate || reduced) {
      // A still frame: figures treat -1 as "show everything at rest".
      paint(-1);
      return;
    }
    let frame = 0;
    const loop = (now: number) => {
      paint(now - startRef.current);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [width, height, visible, animate, reduced, redraw]);

  return <canvas ref={ref} className="ex-canvas" style={{ height }} role="img" aria-label={label} />;
}
