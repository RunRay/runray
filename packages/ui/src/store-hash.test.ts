import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_FILTER } from './lib/filter-runs';
import { useAppStore } from './store';

/**
 * Filter↔hash sync (D6): store→hash goes through history.replaceState
 * (no history spam, no hashchange feedback loop); hash→store never writes
 * back; navigateTo carries the active filter into every route change.
 */

interface StubWindow {
  location: { hash: string };
}

let win: StubWindow;
let replaceState: ReturnType<typeof vi.fn>;

beforeEach(() => {
  win = { location: { hash: '#/dashboard' } };
  replaceState = vi.fn((_s: unknown, _t: unknown, url: string) => {
    win.location.hash = url.slice(url.indexOf('#'));
  });
  (globalThis as Record<string, unknown>).window = win;
  (globalThis as Record<string, unknown>).history = { replaceState };
  useAppStore.setState({
    route: { view: 'dashboard' },
    filter: EMPTY_FILTER,
  });
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
  delete (globalThis as Record<string, unknown>).history;
  useAppStore.setState({ filter: EMPTY_FILTER });
});

describe('filter↔hash sync', () => {
  it('setFilter rewrites the hash via replaceState — never a history entry', () => {
    useAppStore.getState().setFilter({ source: 'opencode' });
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(win.location.hash).toBe('#/dashboard?source=opencode');
    useAppStore.getState().clearFilter();
    expect(replaceState).toHaveBeenCalledTimes(2);
    expect(win.location.hash).toBe('#/dashboard');
  });

  it('idempotent writes are skipped (no replaceState churn)', () => {
    useAppStore.getState().setFilter({ source: 'opencode' });
    replaceState.mockClear();
    useAppStore.getState().setFilter({ source: 'opencode' });
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('filterFromHash applies without writing back (loop guard)', () => {
    useAppStore
      .getState()
      .filterFromHash({ ...EMPTY_FILTER, tool: 'webfetch' });
    expect(useAppStore.getState().filter.tool).toBe('webfetch');
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('navigateTo carries the active filter into the new hash', () => {
    useAppStore.getState().setFilter({ project: 'shop' });
    useAppStore.getState().navigateTo({ view: 'cost', runId: 'run_a' });
    expect(win.location.hash).toBe('#/run/run_a?project=shop');
  });

  it('reattachFilterToHash restores the filter after a filter-less anchor jump', () => {
    useAppStore.getState().setFilter({ source: 'claude-code' });
    // an <a href="#/sessions"> navigation: route changes, hash has no params
    useAppStore.setState({ route: { view: 'sessions' } });
    win.location.hash = '#/sessions';
    replaceState.mockClear();
    useAppStore.getState().reattachFilterToHash();
    expect(win.location.hash).toBe('#/sessions?source=claude-code');
    expect(useAppStore.getState().filter.source).toBe('claude-code');
  });
});
