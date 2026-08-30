import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyTheme, currentTheme, setTheme, THEME_STORAGE_KEY } from './theme';

/**
 * Tests run under Node (no DOM), so we stub the two globals the theme runtime
 * touches. The `typeof document/localStorage` guards are evaluated per call, so
 * stubbing before the call is enough.
 */
function stubDom() {
  const attrs = new Map<string, string>();
  vi.stubGlobal('document', {
    documentElement: {
      getAttribute: (k: string) => attrs.get(k) ?? null,
      setAttribute: (k: string, v: string) => void attrs.set(k, v),
      removeAttribute: (k: string) => void attrs.delete(k),
    },
  });
  return attrs;
}

function stubStorage(setItem?: (k: string, v: string) => void) {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: setItem ?? ((k: string, v: string) => void store.set(k, v)),
  });
  return store;
}

afterEach(() => vi.unstubAllGlobals());

describe('applyTheme / currentTheme', () => {
  it('paper stamps data-theme=light; ink clears it', () => {
    const attrs = stubDom();
    applyTheme('paper');
    expect(attrs.get('data-theme')).toBe('light');
    expect(currentTheme()).toBe('paper');
    applyTheme('ink');
    expect(attrs.has('data-theme')).toBe(false);
    expect(currentTheme()).toBe('ink');
  });

  it('defaults to ink with no DOM (Node/SSR)', () => {
    // no stub: document is undefined here
    expect(currentTheme()).toBe('ink');
    expect(() => applyTheme('paper')).not.toThrow(); // no-op, does not throw
  });
});

describe('setTheme', () => {
  it('applies and persists the choice under the shared key', () => {
    const attrs = stubDom();
    const store = stubStorage();
    setTheme('paper');
    expect(attrs.get('data-theme')).toBe('light');
    expect(store.get(THEME_STORAGE_KEY)).toBe('paper');
    setTheme('ink');
    expect(attrs.has('data-theme')).toBe(false);
    expect(store.get(THEME_STORAGE_KEY)).toBe('ink');
  });

  it('still applies when storage throws (file:// / locked-down mode)', () => {
    const attrs = stubDom();
    stubStorage(() => {
      throw new Error('storage disabled');
    });
    expect(() => setTheme('paper')).not.toThrow();
    expect(attrs.get('data-theme')).toBe('light'); // applied despite persist failing
  });
});
