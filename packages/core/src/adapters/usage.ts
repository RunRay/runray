/**
 * Tool usage capture (add-tool-usage-breakdown, trace-ingestion delta). For
 * shell tools, adapters classify the command per the tool-usage capability
 * and stamp the result into the free-form `span.attributes`; the command
 * text itself is never stored.
 *
 * - `runray.toolActivity` — always, on every shell tool span. Its presence
 *   marks the span as classified.
 * - `runray.tool`, `runray.toolSub`, `runray.toolVia`, `runray.toolsAlso` —
 *   when resolved. Closed vocabularies, so they are emitted in BOTH redact
 *   modes, like `runray.targetKey`.
 * - `runray.toolFlags` — `background`, `timeout`, `interrupted`, where the
 *   source records them.
 * - `runray.toolName`, `runray.toolScript`, `runray.skill` — free-form text
 *   from the session. Emitted ONLY when redaction is off, exactly like the
 *   `content` fields (ParseOptions.redact contract in adapter.ts).
 *
 * `target.ts` is untouched: `runray.targetKey` keeps hashing the first token
 * (design D4).
 */
import { TOOL_ATTR, TOOL_FLAGS, type ToolFlag } from '../tools/attributes.js';
import { toolUsageAttributes } from '../tools/classify.js';
import type { ShellDialect } from '../tools/shell.js';

type Source = 'claude-code' | 'opencode';

/** Shell tools per source and the dialect their `command` is written in. */
const SHELL_TOOLS: Record<Source, Record<string, ShellDialect>> = {
  'claude-code': { Bash: 'posix', PowerShell: 'powershell' },
  opencode: { bash: 'posix' },
};

/** Skill tools per source and the input field that names the skill.
 * OpenCode's `skill` tool records it as `state.input.name` (verified on a
 * local opencode.db, 2026-11-11). */
const SKILL_TOOLS: Record<Source, Record<string, string>> = {
  'claude-code': { Skill: 'skill' },
  opencode: { skill: 'name' },
};

/** A skill name fit to show: one token, no whitespace or control chars. */
const SKILL_NAME = /^[\w@][\w:.@/+-]{0,79}$/;

function strField(input: unknown, field: string): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const v = (input as Record<string, unknown>)[field];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** What the source recorded about how a shell call ended. */
export interface CommandOutcome {
  background?: boolean;
  timedOut?: boolean;
  interrupted?: boolean;
}

/**
 * Claude Code: a call is `background` when it was sent there by its input
 * or the result names a background task, `timeout` when the result records
 * the harness timeout it hit, `interrupted` when the result says so.
 */
export function claudeCommandOutcome(
  input: unknown,
  toolUseResult: unknown,
): CommandOutcome {
  const args = typeof input === 'object' && input !== null ? input : {};
  const result =
    typeof toolUseResult === 'object' && toolUseResult !== null
      ? (toolUseResult as Record<string, unknown>)
      : {};
  return {
    background:
      (args as Record<string, unknown>).run_in_background === true ||
      (typeof result.backgroundTaskId === 'string' &&
        result.backgroundTaskId.length > 0),
    timedOut: typeof result.timedOutAfterMs === 'number',
    interrupted: result.interrupted === true,
  };
}

function flagsOf(outcome: CommandOutcome | undefined): ToolFlag[] {
  if (outcome === undefined) return [];
  const set: Record<ToolFlag, boolean> = {
    background: outcome.background === true,
    timeout: outcome.timedOut === true,
    interrupted: outcome.interrupted === true,
  };
  return TOOL_FLAGS.filter((flag) => set[flag]);
}

/**
 * The tool-usage `attributes` payload for one tool span: the shell
 * classification and result flags for a shell tool, the skill name for a
 * skill tool, `{}` for every other tool.
 */
export function toolUsageSpanAttributes(
  source: Source,
  toolName: string,
  input: unknown,
  redact: boolean,
  outcome?: CommandOutcome,
): Record<string, unknown> {
  // Object.hasOwn, not a bare index: see target.ts — a tool named
  // `constructor` must not resolve to an inherited member
  const shells = SHELL_TOOLS[source];
  if (Object.hasOwn(shells, toolName)) {
    const dialect = shells[toolName] as ShellDialect;
    const out = toolUsageAttributes(
      strField(input, 'command') ?? '',
      dialect,
      redact,
    );
    const flags = flagsOf(outcome);
    if (flags.length > 0) out[TOOL_ATTR.flags] = flags;
    return out;
  }
  const skills = SKILL_TOOLS[source];
  if (!redact && Object.hasOwn(skills, toolName)) {
    const name = strField(input, skills[toolName] as string);
    if (name !== undefined && SKILL_NAME.test(name)) {
      return { [TOOL_ATTR.skill]: name };
    }
  }
  return {};
}
