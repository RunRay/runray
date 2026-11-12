import { OTHER_COMMAND_KEY } from '@runray/core/tools';
import {
  ERROR_OWNER_META,
  type ErrorCluster,
  type ErrorOwner,
  type RunTriage,
  type TriageTone,
  triageRun,
  triageTone,
} from '@runray/core/triage';
import type { Run } from '@runray/schema';

/**
 * UI-side access to the core error triage (error-triage capability). The
 * triage is a pure function of the run, so it is computed once per run
 * object and cached in a WeakMap: the sessions table asks for every run's
 * pill, the run view asks again for the tab, and neither re-walks the
 * spans. Nothing here classifies — that stays in core.
 */

const cache = new WeakMap<Run, RunTriage>();

export function runTriage(run: Run): RunTriage {
  let t = cache.get(run);
  if (t === undefined) {
    t = triageRun(run);
    cache.set(run, t);
  }
  return t;
}

/** Subcommands that say how a program was started, not what it did. */
const GENERIC_SUBS: ReadonlySet<string> = new Set(['run', 'script', 'inline']);

export interface ClusterToolName {
  /** `pnpm run`, `git push`, an MCP tool without its server, `Edit`. */
  name: string;
  /** Dimmed after the name: the activity (`test`) or the MCP server. */
  qualifier?: string;
  /** The harness tool a program ran under (`Bash`), shown as a tag. */
  tag?: string;
}

/**
 * How a cluster's tool reads. A cluster of shell failures names the program
 * it ran, with the activity where the name alone does not say what the call
 * did (`pnpm run · test`, `other command · build`, but `git push` and
 * `tsc`), and the harness tool as a tag; `mcp__<server>__<tool>` reads as the tool with the server beside it.
 */
export function clusterToolName(
  cluster: Pick<ErrorCluster, 'tool' | 'program' | 'mcpServer'>,
): ClusterToolName {
  const { program, mcpServer, tool } = cluster;
  if (program !== undefined) {
    // `pnpm run` and `other command` need the activity to say what ran;
    // `git push` and `tsc` say it themselves
    const sayActivity =
      program.key === OTHER_COMMAND_KEY ||
      (program.sub !== undefined && GENERIC_SUBS.has(program.sub));
    return {
      name: program.label,
      ...(sayActivity ? { qualifier: program.activity } : {}),
      tag: tool,
    };
  }
  if (mcpServer !== undefined) {
    const prefix = `mcp__${mcpServer}__`;
    return {
      name: tool.startsWith(prefix) ? tool.slice(prefix.length) : tool,
      qualifier: mcpServer,
    };
  }
  return { name: tool };
}

/** The same name as one line of text: `pnpm run · test`, `git push`. */
export function clusterToolText(
  cluster: Pick<ErrorCluster, 'tool' | 'program' | 'mcpServer'>,
): string {
  const { name, qualifier } = clusterToolName(cluster);
  return qualifier === undefined ? name : `${name} · ${qualifier}`;
}

/** Owner → the app's colour tokens (text · fill). Hue encodes who can
 * act, never severity: red is reserved for a failed model call. */
export const OWNER_TEXT: Readonly<Record<ErrorOwner, string>> = {
  you: 'text-heat-1',
  tooling: 'text-span-mcp',
  agent: 'text-span-llm',
  model: 'text-error-rose',
  work: 'text-text-faint',
  unknown: 'text-text-dim',
};

export const OWNER_FILL: Readonly<Record<ErrorOwner, string>> = {
  you: 'bg-heat-1',
  tooling: 'bg-span-mcp',
  agent: 'bg-span-llm',
  model: 'bg-error-rose',
  work: 'bg-text-faint',
  unknown: 'bg-border-strong',
};

export interface ErrorPill {
  /** e.g. "13 errors · 1 yours to fix" */
  label: string;
  /** The count alone, e.g. "13 errors" — for the narrow sessions rail. */
  count: string;
  tone: TriageTone;
  /** Tooltip: the owner breakdown. */
  title: string;
}

/**
 * The errors pill for a sessions list: the count stays, the tone comes from
 * the triage (alarm only when something is for the person or the session
 * never got past a failure), and a "· N yours to fix" suffix names the reason
 * when there is one — the wide sessions table shows it, the rail shows
 * `count` alone and keeps the breakdown in the tooltip. Null when the run
 * has no failed calls.
 */
export function errorPill(run: Run): ErrorPill | null {
  const t = runTriage(run);
  const tone = triageTone(t);
  if (tone === 'none') return null;
  const needsYou = t.byOwner.you;
  const head =
    t.toolErrors > 0
      ? `${t.toolErrors} errors`
      : `${t.modelErrors} model error${t.modelErrors === 1 ? '' : 's'}`;
  const label = needsYou > 0 ? `${head} · ${needsYou} yours to fix` : head;
  const parts: string[] = [];
  for (const owner of Object.keys(t.byOwner) as ErrorOwner[]) {
    const n = t.byOwner[owner];
    if (n > 0)
      parts.push(`${n} ${ERROR_OWNER_META[owner].label.toLowerCase()}`);
  }
  const why =
    tone === 'alarm' && needsYou === 0
      ? ' · the session did not get past a failure'
      : tone === 'quiet'
        ? ' · the agent handled them'
        : '';
  return { label, count: head, tone, title: `${parts.join(' · ')}${why}` };
}

/** "1h38" — an offset from the run's start, for time rails and rows. */
export function formatOffset(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
}
