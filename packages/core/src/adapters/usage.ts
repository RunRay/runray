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
 * Hook spans follow the same rule for the command a hook ran, and a
 * stop-hook summary carries `runray.hookCount` (design T9).
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

/** What an SDK callback hook records as its command: there is no program. */
const CALLBACK_COMMAND = 'callback';

/**
 * The transcript does not say which shell ran a hook. A backslash before a
 * name character is a Windows path separator (`C:\Users\…\format.mjs`): bash
 * would swallow it, so a hook written that way is run by cmd or PowerShell,
 * and reading it as POSIX would glue the directories into the script name.
 */
function hookDialect(command: string): ShellDialect {
  return /\\[A-Za-z0-9_.]/.test(command) ? 'powershell' : 'posix';
}

/**
 * The tool-usage `attributes` payload for the command a hook ran. The
 * command is user configuration that may hold paths, so it is classified
 * here and never stored (spec: "Hook commands are classified, never
 * stored"); the redaction rule is the one shell tool spans follow. `{}` for
 * a hook without a command of its own.
 */
export function hookCommandAttributes(
  command: string | undefined,
  redact: boolean,
): Record<string, unknown> {
  const text = command?.trim() ?? '';
  if (text === '' || text === CALLBACK_COMMAND) return {};
  return toolUsageAttributes(text, hookDialect(text), redact);
}

/**
 * The payload for a stop-hook summary, one span standing for `hookCount`
 * hook runs. A single command is classified in full. Several commands name
 * a tool only when every one of them ran the same one: a span has one
 * identity, and picking the first hook's would misreport the others.
 */
export function hookSummaryAttributes(
  commands: readonly string[],
  hookCount: number,
  redact: boolean,
): Record<string, unknown> {
  const classified = commands.map((c) => hookCommandAttributes(c, redact));
  const first = classified[0];
  const out: Record<string, unknown> = {};
  if (first !== undefined && classified.length === 1) {
    Object.assign(out, first);
  } else if (
    first !== undefined &&
    first[TOOL_ATTR.tool] !== undefined &&
    classified.every(
      (c) =>
        c[TOOL_ATTR.tool] === first[TOOL_ATTR.tool] &&
        c[TOOL_ATTR.activity] === first[TOOL_ATTR.activity],
    )
  ) {
    out[TOOL_ATTR.activity] = first[TOOL_ATTR.activity];
    out[TOOL_ATTR.tool] = first[TOOL_ATTR.tool];
  }
  out[TOOL_ATTR.hookCount] = hookCount;
  return out;
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
