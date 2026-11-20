/**
 * scrub-lib.ts — the primitives every scrub path shares: deterministic
 * same-length lorem, path canonicalisation, secret redaction, anonymous
 * identity stand-ins and the SCRUBBED marker record.
 *
 * Moved verbatim out of scrub-fixture.ts so a source-specific scrubber
 * (scrub-codex.ts) and its tests can import them without running the CLI.
 * Changing anything here changes every fixture the next time it is
 * re-scrubbed; see scripts/README.md.
 */

export const MARKER = 'SCRUBBED';

export const LOREM = [
  'lorem',
  'ipsum',
  'dolor',
  'sit',
  'amet',
  'consectetur',
  'adipiscing',
  'elit',
  'sed',
  'tempor',
  'incididunt',
  'labore',
  'magna',
  'aliqua',
  'enim',
  'minim',
  'veniam',
  'quis',
  'nostrud',
  'aliquip',
];

export function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A lorem string of exactly `len` characters (spaces between words). */
export function loremLine(len: number, seed: number): string {
  if (len <= 0) return '';
  const rng = mulberry32(seed);
  let out = '';
  while (out.length < len) {
    const word = LOREM[Math.floor(rng() * LOREM.length)] ?? 'lorem';
    out += (out.length === 0 ? '' : ' ') + word;
  }
  return out.slice(0, len);
}

/** Same length, no spaces — for path/identifier-like segments. */
export function loremToken(len: number, seed: number): string {
  return loremLine(len, seed).replace(/ /g, 'x');
}

/** Replace text with same-length lorem, preserving newline positions. */
export function scrubText(value: string): string {
  return value
    .split('\n')
    .map((line) => loremLine(line.length, fnv1a(line)))
    .join('\n');
}

export function scrubPathSegment(seg: string): string {
  if (seg === '' || seg === '.' || seg === '..') return seg;
  const ext = seg.includes('.') ? seg.slice(seg.lastIndexOf('.')) : '';
  const stem = seg.slice(0, seg.length - ext.length);
  return loremToken(stem.length, fnv1a(seg)) + ext;
}

/**
 * Canonicalize any path to a clean POSIX shape with no real names. Absolute
 * paths (Windows drive or leading slash) reroot to /home/user/project so a
 * fixture captured on Windows and one captured on macOS normalize identically
 * (determinism across contributors). Every real segment is length-preserved
 * lorem; file extensions are kept.
 */
export function scrubPath(value: string): string {
  const unified = value.replace(/\\/g, '/');
  const hadDrive = /^[A-Za-z]:/.test(unified);
  const rest = unified.replace(/^[A-Za-z]:/, '');
  const isAbsolute = hadDrive || rest.startsWith('/');
  const scrubbed = rest
    .split('/')
    .filter((seg) => seg !== '')
    .map(scrubPathSegment);
  return isAbsolute
    ? ['/home/user/project', ...scrubbed].join('/')
    : scrubbed.join('/');
}

export interface Secrets {
  username: string;
  host: string;
}

export function redactSecrets(
  value: string,
  secrets: Secrets,
  opts: { hex?: boolean } = {},
): string {
  let out = value;
  if (secrets.username) out = out.split(secrets.username).join('user');
  if (secrets.host) out = out.split(secrets.host).join('host');
  out = out.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-REDACTED');
  out = out.replace(/Bearer\s+[A-Za-z0-9._-]{8,}/g, 'Bearer REDACTED');
  // The 32+-hex rule would eat OTLP traceIds (exactly 32 hex chars); the OTLP
  // path keeps such ids verbatim and opts out of this pass.
  if (opts.hex !== false)
    out = out.replace(/\b[0-9a-fA-F]{32,}\b/g, 'REDACTEDHEX');
  return out;
}

/** Deterministic anonymous stand-in for an identity value. */
export function anonId(value: string): string {
  if (value.includes('@')) return 'user@example.com';
  return `anon_${fnv1a(value).toString(16).padStart(8, '0')}`;
}

export function metaRecord(source: string): Record<string, unknown> {
  return {
    type: 'x-tracepulse-scrub',
    marker: MARKER,
    source,
    generatedBy: 'scripts/scrub-fixture.ts',
    note: 'Synthetic content; usage/token counts and structure preserved. Never edit by hand.',
  };
}
