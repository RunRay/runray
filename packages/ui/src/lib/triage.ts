import {
  ERROR_OWNER_META,
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
