/**
 * Waterfall Ray favicon (brand/logo/app-theme/runray-symbol-violet.svg),
 * attached at runtime rather than as a <link> in index.html: the export
 * template must carry no <link href> at all (export e2e offline guard),
 * and a data URI keeps it network-free in both the served app and file://.
 */
const FAVICON_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='20 18 216 216'><path fill='#7C5CFF' d='M24 48H212A20 20 0 0 1 212 88H64ZM82 106H156A20 20 0 0 1 156 146H122ZM140 164H212A20 20 0 0 1 212 204H180Z'/></svg>";

export const FAVICON_HREF = `data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}`;

export function installFavicon(doc: Document = document): void {
  if (doc.querySelector('link[rel="icon"]')) return;
  const link = doc.createElement('link');
  link.rel = 'icon';
  link.type = 'image/svg+xml';
  link.href = FAVICON_HREF;
  doc.head.appendChild(link);
}
