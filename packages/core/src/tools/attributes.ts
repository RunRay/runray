/**
 * Reserved span attribute keys of the tool-usage capability (design T3) and
 * the check that a closed-vocabulary value really belongs to its vocabulary.
 *
 * Two privacy classes (design D1). The closed keys carry values drawn from
 * lists in `registry.ts`, are emitted in every redaction mode and are on the
 * sanitizer allowlist. The free-form keys carry text from the session, are
 * emitted only when redaction is off and are never allowlisted.
 */
import { ACTIVITIES, RUNNER_IDS, TOOL_IDS, toolById } from './registry.js';

export const TOOL_ATTR = {
  /** Activity enum. Its presence marks a span as classified. */
  activity: 'runray.toolActivity',
  /** Registry id of the primary tool. */
  tool: 'runray.tool',
  /** Table subcommand, or `run` / `script` / `inline`. */
  sub: 'runray.toolSub',
  /** Runner the tool was launched through. */
  via: 'runray.toolVia',
  /** Other registry tools the command ran. */
  also: 'runray.toolsAlso',
  /** Subset of TOOL_FLAGS, in that order. */
  flags: 'runray.toolFlags',
  /** Number of hooks a stop-hook summary reports. */
  hookCount: 'runray.hookCount',
  /** Free-form: program name outside the registry. */
  name: 'runray.toolName',
  /** Free-form: script, task or script-file name. */
  script: 'runray.toolScript',
  /** Free-form: skill name. */
  skill: 'runray.skill',
} as const;

/** What happened to a shell call besides its exit status; fixed order. */
export const TOOL_FLAGS = ['background', 'timeout', 'interrupted'] as const;
export type ToolFlag = (typeof TOOL_FLAGS)[number];

/** Keys whose values come from closed vocabularies in core. */
export const CLOSED_TOOL_ATTRS: readonly string[] = [
  TOOL_ATTR.activity,
  TOOL_ATTR.tool,
  TOOL_ATTR.sub,
  TOOL_ATTR.via,
  TOOL_ATTR.also,
  TOOL_ATTR.flags,
  TOOL_ATTR.hookCount,
];

/** Keys that carry text from the session. */
export const FREE_TOOL_ATTRS: readonly string[] = [
  TOOL_ATTR.name,
  TOOL_ATTR.script,
  TOOL_ATTR.skill,
];

/** Subcommand tokens that are not table entries of any one tool. */
const GENERIC_SUBS: readonly string[] = ['run', 'script', 'inline'];
/**
 * How many also-ran tools one span names. The classifier stops there and
 * the validator rejects a longer list, so both read this one constant.
 */
export const MAX_ALSO = 8;

const TOOL_ID_SET: ReadonlySet<string> = new Set(TOOL_IDS);
const RUNNER_SET: ReadonlySet<string> = new Set(RUNNER_IDS);
const ACTIVITY_SET: ReadonlySet<string> = new Set(ACTIVITIES);
const FLAG_SET: ReadonlySet<string> = new Set(TOOL_FLAGS);

function distinctStrings(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((v) => typeof v === 'string') &&
    new Set(value).size === value.length
  );
}

/**
 * True when `value` is inside the vocabulary of the closed key `key`. A
 * subcommand is checked against the table of `tool`, the span's own
 * `runray.tool` value. Adapters produce valid values by construction; this
 * guards values that arrive from outside (an OTLP import), which is what
 * lets the sanitizer keep these keys without inspecting them.
 */
export function isValidToolAttribute(
  key: string,
  value: unknown,
  tool?: unknown,
): boolean {
  switch (key) {
    case TOOL_ATTR.activity:
      return typeof value === 'string' && ACTIVITY_SET.has(value);
    case TOOL_ATTR.tool:
      return typeof value === 'string' && TOOL_ID_SET.has(value);
    case TOOL_ATTR.via:
      return typeof value === 'string' && RUNNER_SET.has(value);
    case TOOL_ATTR.sub: {
      if (typeof value !== 'string') return false;
      if (GENERIC_SUBS.includes(value)) return true;
      if (typeof tool !== 'string') return false;
      const table = toolById(tool)?.subs;
      return table !== undefined && Object.hasOwn(table, value);
    }
    case TOOL_ATTR.also:
      return (
        distinctStrings(value) &&
        value.length > 0 &&
        value.length <= MAX_ALSO &&
        value.every((id) => TOOL_ID_SET.has(id))
      );
    case TOOL_ATTR.flags:
      return (
        distinctStrings(value) &&
        value.length > 0 &&
        value.every((flag) => FLAG_SET.has(flag))
      );
    case TOOL_ATTR.hookCount:
      return typeof value === 'number' && Number.isInteger(value) && value >= 0;
    default:
      return false;
  }
}
