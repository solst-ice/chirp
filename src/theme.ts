// The app's light/dark theme. Only the app sets it (main.tsx); the explainer
// and its presentation mode never do, so they stay dark whatever is chosen here.
// The choice is a per-browser convenience in localStorage; with none stored,
// the system's preference decides.

export type Theme = 'dark' | 'light';

const KEY = 'chirp-theme';

export function initialTheme(): Theme {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === 'dark' || stored === 'light') return stored;
  } catch {
    // Storage can be unavailable (private mode); fall back to the system preference.
  }
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** Switch the colour tokens (index.css) and the browser's toolbar colour. */
export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
}

export function storeTheme(theme: Theme) {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Not persisting the choice is fine.
  }
}
