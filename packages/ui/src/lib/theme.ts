/**
 * Theme runtime (add-dashboard-extensions D5). Ink is the default — no
 * attribute at all; paper is `data-theme="light"` on the document root, the
 * selector the stylebook's paper palette (index.css) hangs off.
 *
 * The choice persists in `localStorage` under `THEME_STORAGE_KEY`; the no-flash
 * boot script in `index.html` reads that same key and stamps the attribute
 * before first paint (so a reader who chose paper never sees a flash of ink),
 * and that script is inlined into both the served shell and the single-file
 * export template. This module is the runtime half — apply, persist, toggle —
 * used by the store; `currentTheme()` reads what the boot script already
 * stamped, so no separate read is needed at startup.
 */

export type Theme = 'ink' | 'paper';

/** Shared with the boot script in index.html — keep the literal in sync. */
export const THEME_STORAGE_KEY = 'runray.theme';

/**
 * The theme in effect right now, read straight off the root element. Guarded
 * for non-DOM contexts (the store imports this at module load, and its unit
 * tests run under Node) — ink is the default there.
 */
export function currentTheme(): Theme {
  if (typeof document === 'undefined') return 'ink';
  return document.documentElement.getAttribute('data-theme') === 'light'
    ? 'paper'
    : 'ink';
}

/** Stamp (paper) or clear (ink) the root `data-theme` attribute. */
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (theme === 'paper') root.setAttribute('data-theme', 'light');
  else root.removeAttribute('data-theme');
}

function persist(theme: Theme): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // localStorage can throw under file:// or a locked-down privacy mode —
    // the switch still applies for this session, it just won't survive reload.
  }
}

/** Apply the theme and remember it for next time. */
export function setTheme(theme: Theme): void {
  applyTheme(theme);
  persist(theme);
}
