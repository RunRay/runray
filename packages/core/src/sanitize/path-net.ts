/**
 * Path-shape net (D3, trace-sanitization spec).
 * Matches local filesystem path patterns and file URLs.
 * Case-insensitive matcher for:
 * - `/Users/…`
 * - `/home/…`
 * - `C:\Users\…` and `C:/Users/…` (any drive letter)
 * - UNC paths: `\\server\share`
 * - `\\?\` device/extended paths
 * - `file://…` URLs
 */
const PATH_SHAPE_REGEX =
  /(?:file:\/\/[^\s"'`<>]*)|(?:(?:\/users\/|\/home\/)[^\s"'`<>]+)|(?:[a-zA-Z]:(?:\\|\/|\\\\)+(?:users)(?:\\|\/|\\\\)+[^\s"'`<>]+)|(?:\\\\\\\?\\|\\\\\?\\|\/\/\?\/|\\\\\\\\\\?\\\\)[^\s"'`<>]*|(?:\\\\[a-zA-Z0-9._$-]+\\[a-zA-Z0-9._$-]+|\\\\\\\\[a-zA-Z0-9._$-]+\\\\[a-zA-Z0-9._$-]+)/gi;

export function findPathShapes(text: string): string[] {
  const matches: string[] = [];
  PATH_SHAPE_REGEX.lastIndex = 0;
  let m = PATH_SHAPE_REGEX.exec(text);
  while (m !== null) {
    matches.push(m[0]);
    m = PATH_SHAPE_REGEX.exec(text);
  }
  return matches;
}

export function hasPathShape(text: string): boolean {
  return findPathShapes(text).length > 0;
}

export function assertNoPathShapes(
  text: string,
  knownBasenames?: readonly string[],
): void {
  const matches = findPathShapes(text);
  const foundBasenames: string[] = [];

  if (knownBasenames) {
    for (const base of knownBasenames) {
      if (base && text.includes(base)) {
        foundBasenames.push(base);
      }
    }
  }

  if (matches.length > 0 || foundBasenames.length > 0) {
    const errorParts: string[] = [];
    if (matches.length > 0) {
      errorParts.push(
        `found ${matches.length} path shape(s): ${matches.slice(0, 5).join(', ')}${matches.length > 5 ? '...' : ''}`,
      );
    }
    if (foundBasenames.length > 0) {
      errorParts.push(
        `found known project basename(s): ${foundBasenames.join(', ')}`,
      );
    }
    throw new Error(
      `Path-shape totality assertion failed: ${errorParts.join('; ')}`,
    );
  }
}
