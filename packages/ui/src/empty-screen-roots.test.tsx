import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CheckedRoots } from './components/StatusScreens';
import type { ViewConfigPayload } from './lib/load';

/**
 * §4.7: the checked-roots list is the whole point of the empty state after the
 * wizard's "open the dashboard anyway" branch. Asserted on rendered markup
 * because the defect it guards against — the CLI emitting `verdict` while the
 * UI read `status`, so every verdict rendered blank — is invisible to a
 * store-only test.
 */
describe('EmptyScreen checked roots (§4.7)', () => {
  const roots: ViewConfigPayload['rootsScanned'] = [
    { path: '~/.claude/projects', verdict: 'missing' },
    { path: '~/.local/share/opencode', verdict: 'empty' },
    { path: '~/other', verdict: 'unreadable' },
  ];

  it('renders every checked root with its verdict', () => {
    const html = renderToStaticMarkup(<CheckedRoots roots={roots} />);

    expect(html).toContain('Looked in:');
    expect(html).toContain('~/.claude/projects');
    expect(html).toContain('missing');
    expect(html).toContain('~/.local/share/opencode');
    expect(html).toContain('empty');
    expect(html).toContain('~/other');
    expect(html).toContain('unreadable');
  });

  it('renders nothing when no roots were supplied', () => {
    expect(renderToStaticMarkup(<CheckedRoots roots={undefined} />)).toBe('');
    expect(renderToStaticMarkup(<CheckedRoots roots={[]} />)).toBe('');
  });

  it('carries no absolute filesystem path (the CLI abbreviates before sending)', () => {
    const html = renderToStaticMarkup(<CheckedRoots roots={roots} />);
    expect(html).not.toMatch(/\/Users\/|\/home\/|[A-Z]:\\/);
  });
});
