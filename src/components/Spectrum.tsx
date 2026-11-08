import React, { useEffect, useRef } from 'react';

// Spectrum + waterfall drawn on a character grid so it reads like a terminal
// UI: block-element bars (▁▂▃▄▅▆▇█) with peak hold, a dB gutter, a kHz axis,
// and a scrolling ░▒▓█ waterfall. Bars are filled rectangles snapped to
// eighths of a cell, which is exactly what the block glyphs would draw.

interface SpectrumProps {
  analyser: AnalyserNode | null;
  sampleRate: number;
  maxFrequency: number;
  /** Band of the selected transmit mode, bracketed and tinted. */
  band: [number, number];
  bandLabel: string;
  transmitting: boolean;
  /** Changing it re-reads the colour tokens; the waterfall shades have a ramp per theme. */
  theme: 'dark' | 'light';
}

const FONT = '16px Unifont, monospace';
const GUTTER = 5;
const WATERFALL_TICK_MS = 90;
const SHADES = [' ', '░', '▒', '▓', '█'];
// Waterfall shades, faint to strong: towards white on the dark theme, towards ink on paper.
const SHADE_COLORS = {
  dark: { rx: ['', '#174456', '#1f7896', '#29d8ff', '#d8f6ff'], tx: ['', '#174a2b', '#21854a', '#3ddc84', '#d8ffe8'] },
  light: { rx: ['', '#c6dadd', '#7cb0bd', '#237d95', '#00445a'], tx: ['', '#cddecb', '#83b690', '#2a814c', '#0b4721'] },
};

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const Spectrum: React.FC<SpectrumProps> = ({ analyser, sampleRate, maxFrequency, band, bandLabel, transmitting, theme }) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Props read by the animation loop without restarting it.
  const live = useRef({ band, bandLabel, transmitting, theme });
  live.current = { band, bandLabel, transmitting, theme };

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!wrap || !canvas || !ctx) return;

    let cw = 8;
    const ch = 16;
    let cols = 0;
    let specRows = 10;
    let waterRows = 8;
    let plot = 0;
    let dpr = 1;
    let peaks = new Float32Array(0);
    let accum = new Float32Array(0);
    const water = document.createElement('canvas');
    const wctx = water.getContext('2d')!;
    const data = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;
    const binHz = sampleRate / 2 / (analyser?.frequencyBinCount ?? 1024);
    let frame = 0;
    let lastWater = 0;
    let stopped = false;
    let colorsFor: string | null = null;

    const colors = {
      fg: '#c9d1d9',
      dim: '#5c6773',
      line: '#2a3140',
      accent: '#ff2b6d',
      rx: '#29d8ff',
      tx: '#3ddc84',
      warn: '#ffb000',
      bg: '#0a0c10',
      tint: 0.035,
    };

    const readColors = () => {
      colors.fg = css('--fg') || colors.fg;
      colors.dim = css('--dim') || colors.dim;
      colors.line = css('--line') || colors.line;
      colors.accent = css('--accent') || colors.accent;
      colors.rx = css('--rx') || colors.rx;
      colors.tx = css('--tx') || colors.tx;
      colors.warn = css('--warn') || colors.warn;
      colors.bg = css('--bg') || colors.bg;
      colors.tint = Number(css('--band-tint')) || colors.tint;
      colorsFor = live.current.theme;
    };

    const layout = () => {
      ctx.font = FONT;
      cw = Math.max(6, Math.round(ctx.measureText('█').width)) || 8;
      cols = Math.max(GUTTER + 20, Math.floor(wrap.clientWidth / cw));
      // Shorter on narrow screens, and on any window under 960 px tall: the
      // composer sits below the spectrum and must stay on a laptop's first screen.
      const compact = cols < 70 || window.innerHeight < 960;
      specRows = compact ? 7 : 10;
      waterRows = compact ? 5 : 8;
      plot = cols - GUTTER;
      const rows = 1 + specRows + 1 + 1 + waterRows;
      dpr = window.devicePixelRatio || 1;
      canvas.width = cols * cw * dpr;
      canvas.height = rows * ch * dpr;
      canvas.style.width = `${cols * cw}px`;
      canvas.style.height = `${rows * ch}px`;
      water.width = plot * cw * dpr;
      water.height = waterRows * ch * dpr;
      wctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      wctx.font = FONT;
      wctx.textBaseline = 'top';
      peaks = new Float32Array(plot);
      accum = new Float32Array(plot);
    };

    const text = (s: string, col: number, row: number, color: string) => {
      ctx.fillStyle = color;
      ctx.fillText(s, col * cw, row * ch);
    };

    /** Column value 0..1 for the analyser bins under each plot column. */
    const columns = (): Float32Array => {
      const out = new Float32Array(plot);
      if (!analyser || !data) return out;
      analyser.getByteFrequencyData(data);
      for (let i = 0; i < plot; i++) {
        const from = Math.floor((i * maxFrequency) / plot / binHz);
        const to = Math.max(from + 1, Math.floor(((i + 1) * maxFrequency) / plot / binHz));
        let v = 0;
        for (let b = from; b < to && b < data.length; b++) v = Math.max(v, data[b]);
        out[i] = v / 255;
      }
      return out;
    };

    const colOf = (freq: number) => GUTTER + Math.min(plot - 1, Math.max(0, Math.floor((freq / maxFrequency) * plot)));

    const drawWaterfallRow = (values: Float32Array, tx: boolean) => {
      const w = plot * cw;
      wctx.save();
      wctx.setTransform(1, 0, 0, 1, 0, 0);
      wctx.drawImage(water, 0, ch * dpr);
      wctx.restore();
      wctx.fillStyle = colors.bg;
      wctx.fillRect(0, 0, w, ch);
      const ramp = SHADE_COLORS[live.current.theme][tx ? 'tx' : 'rx'];
      for (let i = 0; i < plot; i++) {
        const level = Math.min(4, Math.floor(Math.pow(values[i], 1.6) * 5.5));
        if (level === 0) continue;
        wctx.fillStyle = ramp[level];
        wctx.fillText(SHADES[level], i * cw, 0);
      }
    };

    const draw = (now: number) => {
      if (stopped) return;
      frame = requestAnimationFrame(draw);
      const { band, bandLabel, transmitting, theme } = live.current;
      // The theme changed: the tokens are already switched, so read them again,
      // and drop the waterfall's history, drawn on the old background.
      if (theme !== colorsFor) {
        readColors();
        wctx.save();
        wctx.setTransform(1, 0, 0, 1, 0, 0);
        wctx.clearRect(0, 0, water.width, water.height);
        wctx.restore();
      }
      const values = columns();
      for (let i = 0; i < plot; i++) accum[i] = Math.max(accum[i], values[i]);
      if (now - lastWater > WATERFALL_TICK_MS) {
        drawWaterfallRow(accum, transmitting);
        accum.fill(0);
        lastWater = now;
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.font = FONT;
      ctx.textBaseline = 'top';
      ctx.fillStyle = colors.bg;
      ctx.fillRect(0, 0, cols * cw, canvas.height / dpr);

      const barColor = transmitting ? colors.tx : colors.rx;
      const top = 1;
      const bottom = top + specRows;

      // Header row: band bracket and peak readout.
      const b0 = colOf(band[0]);
      const b1 = Math.max(b0 + 1, colOf(band[1]));
      const label = ` ${bandLabel} `;
      const bracket = `├${'─'.repeat(Math.max(0, b1 - b0 - 1))}┤`;
      text(bracket, b0, 0, colors.dim);
      if (label.length < b1 - b0 - 1) text(label, b0 + Math.floor((b1 - b0 - label.length) / 2) + 1, 0, barColor);
      else text(bandLabel, Math.min(b1 + 2, cols - bandLabel.length), 0, barColor);

      let peakBin = 0;
      if (data) for (let i = 1; i < data.length && i * binHz <= maxFrequency; i++) if (data[i] > data[peakBin]) peakBin = i;
      const peakText =
        data && data[peakBin] > 40 && analyser
          ? `PEAK ${((peakBin * binHz) / 1000).toFixed(2)}kHz ${Math.round(
              analyser.minDecibels + (data[peakBin] / 255) * (analyser.maxDecibels - analyser.minDecibels),
            )}dB`
          : 'PEAK --';
      const peakCol = cols - peakText.length;
      if (peakCol > b1 + 1 || peakCol + peakText.length < b0) text(peakText, peakCol, 0, colors.dim);

      // Selected band tint.
      ctx.globalAlpha = colors.tint;
      ctx.fillStyle = barColor;
      ctx.fillRect(b0 * cw, top * ch, (b1 - b0 + 1) * cw, specRows * ch);
      ctx.globalAlpha = 1;

      // dB gutter and axis line.
      if (analyser) {
        const mid = Math.round((analyser.minDecibels + analyser.maxDecibels) / 2);
        text(`${Math.round(analyser.maxDecibels)}`.padStart(4), 0, top, colors.dim);
        text(`${mid}`.padStart(4), 0, top + Math.floor(specRows / 2), colors.dim);
        text(`${Math.round(analyser.minDecibels)}`.padStart(4), 0, bottom - 1, colors.dim);
      }
      for (let r = top; r < bottom; r++) text('│', GUTTER - 1, r, colors.line);

      // Bars, snapped to eighths of a cell like ▁▂▃▄▅▆▇█.
      for (let i = 0; i < plot; i++) {
        const eighths = Math.round(values[i] * specRows * 8);
        const x = (GUTTER + i) * cw;
        const inBand = GUTTER + i >= b0 && GUTTER + i <= b1;
        ctx.globalAlpha = inBand ? 1 : 0.45;
        ctx.fillStyle = barColor;
        if (eighths > 0) {
          const h = (eighths / 8) * ch;
          ctx.fillRect(x, bottom * ch - h, cw - 1, h);
        }
        peaks[i] = Math.max(peaks[i] - 0.04, values[i]);
        const peakEighths = Math.round(peaks[i] * specRows * 8);
        if (peakEighths > eighths + 2) {
          ctx.fillStyle = colors.warn;
          ctx.fillRect(x, bottom * ch - (peakEighths / 8) * ch, cw - 1, 2);
        }
      }
      ctx.globalAlpha = 1;

      // kHz axis: └──0k────2k────4k──
      text('└'.padStart(GUTTER, ' '), 0, bottom, colors.line);
      text('─'.repeat(plot), GUTTER, bottom, colors.line);
      const khz = maxFrequency / 1000;
      const step = [1, 2, 5, 10].find((s) => (plot * s) / khz >= 7) ?? 10;
      for (let k = 0; k <= khz; k += step) {
        const col = GUTTER + Math.round((k / khz) * (plot - 1));
        const s = `${k}k`;
        text(s, Math.min(col, cols - s.length), bottom, colors.dim);
      }

      // Waterfall.
      text('time', 0, bottom + 1, colors.dim);
      text(`▼ waterfall · ${((waterRows * WATERFALL_TICK_MS) / 1000).toFixed(1)}s`, GUTTER, bottom + 1, colors.dim);
      for (let r = 0; r < waterRows; r++) text('│', GUTTER - 1, bottom + 2 + r, colors.line);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(water, GUTTER * cw * dpr, (bottom + 2) * ch * dpr);
      ctx.restore();

      if (!analyser) {
        const msg = '[ no audio input ]';
        text(msg, GUTTER + Math.floor((plot - msg.length) / 2), top + Math.floor(specRows / 2), colors.dim);
      }
    };

    const start = () => {
      if (stopped) return;
      readColors();
      layout();
      frame = requestAnimationFrame(draw);
    };
    const ro = new ResizeObserver(() => {
      layout();
    });
    // Height alone (e.g. rotating a phone) can change the density without resizing the canvas's box.
    window.addEventListener('resize', layout);
    // Measure with the bitmap font once it is available.
    (document.fonts?.load(FONT) ?? Promise.resolve()).catch(() => undefined).then(start);
    ro.observe(wrap);

    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      ro.disconnect();
      window.removeEventListener('resize', layout);
    };
  }, [analyser, sampleRate, maxFrequency]);

  return (
    <div className="spectrum" ref={wrapRef}>
      <canvas ref={canvasRef} aria-label="Live frequency spectrum and waterfall" role="img" />
    </div>
  );
};

export default Spectrum;
