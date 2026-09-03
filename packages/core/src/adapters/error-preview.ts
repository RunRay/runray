/**
 * Failure-text selection shared by the three adapters (spec: trace-ingestion
 * "Tool error text capture", "User-rejected tool calls are decisions").
 *
 * A failed tool's text is the one thing a finding can quote and the one
 * input an error class can be read from, so the preview has to start where
 * the failure is NAMED, not where the log happens to begin: a batch tool
 * logs its successful steps first and fails at the end, a shell wrapper
 * prefixes `Exit code N` before the message. The rules here are plain
 * string heuristics — deterministic, documented, and wrong in the same way
 * every time, which is what goldens need.
 */

export const ERROR_PREVIEW_CHARS = 200;

/** A line that names a failure. Word-bounded on purpose: `tool_use_error`
 * and `ERR_MODULE_NOT_FOUND` are not matches, and those lines are kept by
 * the first-line fallback anyway. */
const FAILURE_LINE = /\b(?:fail(?:ed|ure|ing)?|error|exception)\b/i;
/** …unless the line says there was none. */
const NEGATED_LINE =
  /\b(?:no|0|zero)\s+(?:errors?|failures?)\b|\bwithout\s+(?:errors?|failures?)\b|\b0\s+failed\b|\berrors?:\s*0\b/i;
/** The shell wrapper's own first line (Claude Code's Bash/PowerShell). */
const EXIT_CODE_LINE = /^\s*(?:Error:\s*)?Exit code (\d+)\s*$/i;
/** The harness reporting that the person declined or stopped the call —
 * Claude Code's two phrasings and its interrupt marker, OpenCode's
 * permission refusal and its abort message. */
const USER_REJECTION =
  /^\s*(?:Error:\s*)?(?:The user doesn't want to (?:proceed|take this action)|\[Request interrupted by user|The user rejected permission|Tool execution aborted)/i;

interface Line {
  start: number;
  text: string;
}

function nonEmptyLines(text: string): Line[] {
  const out: Line[] = [];
  let start = 0;
  for (;;) {
    const nl = text.indexOf('\n', start);
    const end = nl === -1 ? text.length : nl;
    const raw = text.slice(start, end).replace(/\r$/, '');
    if (raw.trim() !== '') out.push({ start, text: raw });
    if (nl === -1) break;
    start = nl + 1;
  }
  return out;
}

/**
 * The preview of a failure's text: `max` characters starting at the LAST
 * line that names a failure (and does not negate it), else at the first
 * non-empty line that is not the wrapper's `Exit code N`, else at the first
 * non-empty line. `undefined` stays `undefined`; whitespace-only text is
 * returned as is, so an adapter's "no text" and "empty text" stay distinct.
 */
export function errorPreview(
  text: string | undefined,
  max = ERROR_PREVIEW_CHARS,
): string | undefined {
  if (text === undefined) return undefined;
  const lines = nonEmptyLines(text);
  const first = lines[0];
  if (first === undefined) return text.slice(0, max);
  let chosen: Line | undefined;
  for (const line of lines) {
    if (FAILURE_LINE.test(line.text) && !NEGATED_LINE.test(line.text)) {
      chosen = line;
    }
  }
  if (chosen === undefined) {
    chosen = lines.find((l) => !EXIT_CODE_LINE.test(l.text)) ?? first;
  }
  return text.slice(chosen.start, chosen.start + max);
}

/** `Exit code N` from the wrapper's first line, else undefined. */
export function exitCodeOf(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const first = nonEmptyLines(text)[0];
  if (first === undefined) return undefined;
  const m = EXIT_CODE_LINE.exec(first.text);
  return m?.[1] === undefined ? undefined : Number(m[1]);
}

/** True when the "failure" is the person declining the call. */
export function isUserRejection(text: string | undefined): boolean {
  return text !== undefined && USER_REJECTION.test(text);
}
