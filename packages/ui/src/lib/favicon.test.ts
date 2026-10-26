/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { FAVICON_HREF, installFavicon } from './favicon';

describe('installFavicon', () => {
  it('attaches one inline svg icon and never a network url', () => {
    installFavicon();
    installFavicon();
    const links = document.querySelectorAll('link[rel="icon"]');
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute('href')).toBe(FAVICON_HREF);
    expect(FAVICON_HREF.startsWith('data:image/svg+xml,')).toBe(true);
  });
});
