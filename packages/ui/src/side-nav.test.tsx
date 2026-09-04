import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NavRail } from './components/SideNavBar';
import { useAppStore } from './store';

/**
 * The navigation rail collapses to icons and back (visualizer "Collapsible
 * navigation rail"): every destination keeps a name, the toggle says which
 * way it goes, the current destination stays marked, and the store flips
 * the flag. The rail renders from props: a static render reads a store's
 * initial snapshot, never a toggled one. Persistence is a guarded
 * localStorage write, which the node environment exercises as the guard.
 */

const noop = () => {};

describe('NavRail', () => {
  it('expanded: names beside icons and a collapse control', () => {
    const html = renderToStaticMarkup(
      <NavRail
        route={{ view: 'dashboard' }}
        collapsed={false}
        onToggle={noop}
      />,
    );
    // the name follows the icon; the icon's own <title> is not the label
    expect(html).toContain('</svg>Dashboard</a>');
    expect(html).toContain('</svg>Explorer</a>');
    expect(html).toContain('Local · Offline');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-label="Collapse the navigation"');
    // an icon-only control in the header row, before the destinations
    expect(html.indexOf('aria-label="Collapse the navigation"')).toBeLessThan(
      html.indexOf('href="#/sessions"'),
    );
    expect(html).not.toContain('>Collapse<');
    expect(html).not.toContain('data-collapsed');
    expect(html).toContain('w-60');
  });

  it('collapsed: icons only, every destination still named', () => {
    const html = renderToStaticMarkup(
      <NavRail
        route={{ view: 'dashboard' }}
        collapsed={true}
        onToggle={noop}
      />,
    );
    expect(html).toContain('data-collapsed="true"');
    expect(html).toContain('w-14');
    expect(html).not.toContain('</svg>Dashboard</a>');
    expect(html).not.toContain('</svg>Explorer</a>');
    expect(html).toContain('aria-label="Dashboard"');
    expect(html).toContain('aria-label="Explorer"');
    expect(html).toContain('aria-label="Local · Offline"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Expand the navigation"');
  });

  it('marks the current destination in both states', () => {
    for (const collapsed of [false, true]) {
      const html = renderToStaticMarkup(
        <NavRail
          route={{ view: 'waste', runId: 'r1' }}
          collapsed={collapsed}
          onToggle={noop}
        />,
      );
      expect(html).toContain('href="#/sessions" aria-current="page"');
      expect(html).not.toContain('href="#/dashboard" aria-current="page"');
    }
  });
});

describe('store.toggleNav', () => {
  it('flips the flag and survives an environment without localStorage', () => {
    const before = useAppStore.getState().ui.navCollapsed;
    useAppStore.getState().toggleNav();
    expect(useAppStore.getState().ui.navCollapsed).toBe(!before);
    useAppStore.getState().toggleNav();
    expect(useAppStore.getState().ui.navCollapsed).toBe(before);
  });
});
