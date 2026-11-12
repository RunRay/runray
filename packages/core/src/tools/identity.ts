/**
 * Tool identity resolution (tool-usage capability, design T2): from a
 * normalized span to the tool it stands for. This module is the single
 * reader of the `runray.tool*` attributes; every consumer goes through
 * `toolIdentity` so the Time view, a later dashboard card and a later CLI
 * report cannot disagree about what a span is.
 *
 * What was learned from tool input at parse time is read from the stamped
 * attributes. Everything else is resolved here from fields the span already
 * has: a harness tool's activity from its name, the MCP roll-up from
 * `tool.mcpServer`, the agent family from the subagent span a call contains,
 * the hook family from `span.kind`. A trace produced before the attributes
 * existed therefore still resolves, at the fidelity of the harness tool name.
 *
 * Attribute values are validated before use: a payload may come from an
 * exported report or an import, not only from this version's adapters.
 */
import type { Span } from '@runray/schema';
import {
  isValidToolAttribute,
  TOOL_ATTR,
  TOOL_FLAGS,
  type ToolFlag,
} from './attributes.js';
import {
  type Activity,
  HARNESS_TOOLS,
  harnessActivity,
  type ToolDef,
  toolById,
} from './registry.js';

/** Where a tool call belongs. Closed set. */
export const TOOL_FAMILIES = [
  'shell',
  'harness',
  'mcp',
  'skill',
  'agent',
  'hook',
] as const;
export type ToolFamily = (typeof TOOL_FAMILIES)[number];

/**
 * Key of the row that holds classified shell calls whose program is not a
 * registry tool. With redaction on that is all that is known about them;
 * with redaction off the program name is the identity's `detail`.
 */
export const OTHER_COMMAND_KEY = 'other-command';
export const OTHER_COMMAND_LABEL = 'other command';

/** Longest free-form text (a script, program or skill name) worth showing. */
const MAX_DETAIL_CHARS = 80;

export interface ToolIdentity {
  family: ToolFamily;
  /**
   * Groups calls of one tool within a family: a registry id, an MCP server,
   * a skill name, an agent type, a hook name or a harness tool name.
   */
  key: string;
  label: string;
  /** True when `key` is an id of the closed tool registry. */
  registry: boolean;
  /**
   * Closed vocabulary: a table subcommand (`compose up`), one of `run`,
   * `script` and `inline`, the tool name of an MCP call, or the registry id
   * of the tool a hook's command ran.
   */
  sub?: string;
  /**
   * Free-form text from the session: the script a tool ran, or the name of
   * a program outside the registry. Absent under redaction.
   */
  detail?: string;
  /**
   * Set on a hook span that reports several hook runs together (a stop-hook
   * summary): how many. The source records no duration for such a span.
   */
  hookRuns?: number;
  activity: Activity;
  /** Runner the tool was launched through (`pnpm exec`). */
  via?: string;
  /** Other registry tools the same command ran, in order of appearance. */
  also: readonly string[];
  /** Subset of TOOL_FLAGS, in that order. */
  flags: readonly ToolFlag[];
  /** The call contains a subagent: its time is the subagent's work. */
  container: boolean;
  /** One of the short-lived shell tools the Time view folds into a group. */
  utility: boolean;
  /**
   * False only for a shell call that carries no tool-usage attributes: the
   * trace was produced before commands were classified.
   */
  classified: boolean;
}

/** What a run tells about its tool spans beyond the spans themselves. */
export interface IdentityContext {
  /** Container call id → the subagent spans it is the parent of. */
  readonly subagents: ReadonlyMap<string, readonly Span[]>;
}

const TOOL_KINDS: ReadonlySet<Span['kind']> = new Set([
  'tool_call',
  'mcp_call',
  'hook',
]);

/** True for the span kinds that resolve to a tool identity. */
export function isToolSpan(span: Span): boolean {
  return TOOL_KINDS.has(span.kind);
}

/** Index the run once; pass the result to every `toolIdentity` call. */
export function identityContext(spans: readonly Span[]): IdentityContext {
  const callIds = new Set<string>();
  for (const span of spans) {
    if (span.kind === 'tool_call' || span.kind === 'mcp_call') {
      callIds.add(span.id);
    }
  }
  const subagents = new Map<string, Span[]>();
  for (const span of spans) {
    if (span.kind !== 'subagent' || span.parentId === null) continue;
    if (!callIds.has(span.parentId)) continue;
    const list = subagents.get(span.parentId);
    if (list === undefined) subagents.set(span.parentId, [span]);
    else list.push(span);
  }
  return { subagents };
}

const NO_CONTEXT: IdentityContext = { subagents: new Map() };

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_DETAIL_CHARS
    ? trimmed
    : undefined;
}

function flagsOf(span: Span): readonly ToolFlag[] {
  const value = span.attributes[TOOL_ATTR.flags];
  if (!isValidToolAttribute(TOOL_ATTR.flags, value)) return [];
  const present = value as readonly string[];
  return TOOL_FLAGS.filter((flag) => present.includes(flag));
}

function activityOf(span: Span): Activity | undefined {
  const value = span.attributes[TOOL_ATTR.activity];
  return isValidToolAttribute(TOOL_ATTR.activity, value)
    ? (value as Activity)
    : undefined;
}

/** The name the harness gave the tool; OTLP keeps it apart from the span name. */
function harnessName(span: Span): string {
  const name = span.tool?.name;
  return name !== undefined && name.length > 0 ? name : span.name;
}

/** `mcp__server__tool` and `server_tool` → `tool`. */
function mcpToolName(name: string, server: string): string {
  const qualified = `mcp__${server}__`;
  if (name.startsWith(qualified) && name.length > qualified.length) {
    return name.slice(qualified.length);
  }
  const joined = `${server}_`;
  if (name.startsWith(joined) && name.length > joined.length) {
    return name.slice(joined.length).replace(/^_+/, '') || name;
  }
  return name;
}

function agentName(subagents: readonly Span[], fallback: string): string {
  for (const sub of subagents) {
    const name = text(sub.agent?.name);
    if (name !== undefined) return name;
  }
  for (const sub of subagents) {
    const name = text(sub.name.replace(/^subagent:/, ''));
    if (name !== undefined) return name;
  }
  return fallback;
}

interface Base {
  flags: readonly ToolFlag[];
  container: boolean;
}

function identity(
  base: Base,
  family: ToolFamily,
  key: string,
  activity: Activity,
  extra: Partial<ToolIdentity> = {},
): ToolIdentity {
  return {
    family,
    key,
    label: key,
    registry: false,
    activity,
    also: [],
    flags: base.flags,
    container: base.container,
    utility: false,
    classified: true,
    ...extra,
  };
}

/** The registry entry a span is stamped with, when the id is a real one. */
function stampedTool(span: Span): ToolDef | undefined {
  const tool = span.attributes[TOOL_ATTR.tool];
  return typeof tool === 'string' && isValidToolAttribute(TOOL_ATTR.tool, tool)
    ? toolById(tool)
    : undefined;
}

function shellIdentity(span: Span, base: Base, name: string): ToolIdentity {
  const stamped = activityOf(span);
  const def = stampedTool(span);
  if (def === undefined) {
    if (stamped === undefined) {
      // produced before classification: only the harness tool is known
      return identity(base, 'shell', name, harnessActivity(name), {
        classified: false,
      });
    }
    const detail = text(span.attributes[TOOL_ATTR.name]);
    return identity(base, 'shell', OTHER_COMMAND_KEY, stamped, {
      label: OTHER_COMMAND_LABEL,
      ...(detail === undefined ? {} : { detail }),
    });
  }
  const attrs = span.attributes;
  const sub = attrs[TOOL_ATTR.sub];
  const via = attrs[TOOL_ATTR.via];
  const also = attrs[TOOL_ATTR.also];
  const detail = text(attrs[TOOL_ATTR.script]);
  return identity(base, 'shell', def.id, stamped ?? def.activity, {
    label: def.label,
    registry: true,
    utility: def.utility === true || def.plumbing === true,
    ...(isValidToolAttribute(TOOL_ATTR.sub, sub, def.id)
      ? { sub: sub as string }
      : {}),
    ...(isValidToolAttribute(TOOL_ATTR.via, via) ? { via: via as string } : {}),
    ...(isValidToolAttribute(TOOL_ATTR.also, also)
      ? { also: (also as string[]).filter((id) => id !== def.id) }
      : {}),
    ...(detail === undefined ? {} : { detail }),
  });
}

/**
 * A hook is keyed by its name (event and matcher). What its command ran is
 * the subcommand, so two hooks on one event stay apart: `PostToolUse:Edit`
 * can hold a `prettier` sub-row and a `node` one. A summary of several hook
 * runs has no one command and no duration.
 */
function hookIdentity(span: Span, base: Base): ToolIdentity {
  const activity = activityOf(span) ?? 'other';
  const count = span.attributes[TOOL_ATTR.hookCount];
  if (isValidToolAttribute(TOOL_ATTR.hookCount, count)) {
    return identity(base, 'hook', span.name, activity, {
      hookRuns: count as number,
    });
  }
  const def = stampedTool(span);
  const detail = text(
    span.attributes[def === undefined ? TOOL_ATTR.name : TOOL_ATTR.script],
  );
  return identity(base, 'hook', span.name, activity, {
    ...(def === undefined ? {} : { sub: def.id }),
    ...(detail === undefined ? {} : { detail }),
  });
}

/**
 * The identity of a tool, MCP or hook span; `undefined` for any other kind.
 * Pure: the same span and context always resolve to the same identity.
 * Without a context no call is recognised as a container.
 */
export function toolIdentity(
  span: Span,
  context: IdentityContext = NO_CONTEXT,
): ToolIdentity | undefined {
  if (!isToolSpan(span)) return undefined;
  const flags = flagsOf(span);

  if (span.kind === 'hook') {
    return hookIdentity(span, { flags, container: false });
  }

  const name = harnessName(span);
  const subagents = context.subagents.get(span.id);
  if (subagents !== undefined && subagents.length > 0) {
    return identity(
      { flags, container: true },
      'agent',
      agentName(subagents, name),
      'agent',
    );
  }

  const base: Base = { flags, container: false };
  const server = span.tool?.mcpServer;
  if (server !== undefined && server.length > 0) {
    return identity(base, 'mcp', server, 'integration', {
      sub: mcpToolName(name, server),
    });
  }
  if (span.kind === 'mcp_call') {
    return identity(base, 'mcp', name, 'integration');
  }

  const harness = HARNESS_TOOLS.get(name);
  // a tool outside the harness table that carries a classification is a
  // shell tool under a name of its own (an imported span of a custom agent)
  const custom =
    harness === undefined &&
    (activityOf(span) !== undefined || stampedTool(span) !== undefined);
  if (harness?.role === 'shell' || custom) {
    return shellIdentity(span, base, name);
  }
  if (harness?.role === 'skill') {
    const skill = text(span.attributes[TOOL_ATTR.skill]);
    return identity(base, 'skill', skill ?? name, harness.activity);
  }
  if (harness?.role === 'agent') {
    return identity(base, 'agent', name, harness.activity);
  }
  return identity(base, 'harness', name, harness?.activity ?? 'other');
}
