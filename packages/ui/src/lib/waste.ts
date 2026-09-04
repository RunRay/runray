import { playbookActions } from '@runray/core/insights-meta';
import {
  DEFAULT_SEVERITY_THRESHOLDS,
  type RunWaste,
  type WasteGroup,
  wasteRun,
} from '@runray/core/waste';
import type { Run } from '@runray/schema';
import { formatTokensCompact, formatUSD } from './format';

/**
 * UI-side access to the core waste grouping (waste-grouping capability).
 * The grouping is a pure function of the run, computed once per run object
 * and cached in a WeakMap: the tab bar asks for the badge, the tab asks
 * for the groups, neither re-walks the findings. Nothing here regroups or
 * regrades — that stays in core; this file only words it.
 */

const cache = new WeakMap<Run, RunWaste>();

export function runWaste(run: Run): RunWaste {
  let w = cache.get(run);
  if (w === undefined) {
    w = wasteRun(run);
    cache.set(run, w);
  }
  return w;
}

export interface WasteBadge {
  /** The burned amount, e.g. "$111.04". */
  text: string;
  /** alarm once the burned share reaches the warning share. */
  tone: 'alarm' | 'quiet';
  title: string;
}

/** The tab-bar badge: the burned amount, tinted the way the engine would
 * grade it. Null when nothing was burned. */
export function wasteBadge(run: Run): WasteBadge | null {
  const w = runWaste(run);
  if (w.burnedUSD <= 0) return null;
  const share = `${(w.burnedShare * 100).toFixed(w.burnedShare < 0.1 ? 1 : 0)}%`;
  const opp =
    w.opportunityUSD > 0
      ? ` · up to ${formatUSD(w.opportunityUSD)} in opportunities`
      : '';
  return {
    text: formatUSD(w.burnedUSD),
    tone:
      w.burnedShare >= DEFAULT_SEVERITY_THRESHOLDS.warningShare
        ? 'alarm'
        : 'quiet',
    title: `${formatUSD(w.burnedUSD)} burned · ${share} of this session${opp}`,
  };
}

/** Where the person records facts for the next session, per source. */
export function instructionsFile(source: string): string {
  if (source === 'claude-code') return 'CLAUDE.md';
  if (source === 'opencode') return 'AGENTS.md';
  return 'the system prompt';
}

export const tok = formatTokensCompact;

export interface Lead {
  /** "Most of the burn is one pattern:" — how much the top group explains. */
  opening: string;
  /** What happened, with the amount. */
  what: string;
  /** The one lever, for the run's own source. */
  lever: string;
}

/** The one sentence the tab opens with: the largest burned group, worded
 * by what it was, and the lever the person has for it. Null when nothing
 * was burned. */
export function leadSentence(w: RunWaste, source: string): Lead | null {
  const top = w.burned.find((g) => g.usd > 0);
  if (top === undefined) return null;
  const burnedSum = w.burned.reduce((acc, g) => acc + g.usd, 0);
  const opening =
    burnedSum > 0 && top.usd / burnedSum >= 0.6
      ? 'Most of the burn is one pattern:'
      : 'The largest burn:';
  const { what, lever } = wording(top, source);
  return { opening, what, lever };
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function wording(
  g: WasteGroup,
  source: string,
): { what: string; lever: string } {
  const usd = formatUSD(g.usd);
  const custom = source !== 'claude-code' && source !== 'opencode';
  switch (g.ruleId) {
    case 'cache-prefix-break': {
      const shapes = g.shapes ?? {};
      const history = shapes.history ?? { count: 0, usd: 0 };
      const front = shapes.front ?? { count: 0, usd: 0 };
      const compaction = shapes.compaction ?? { count: 0, usd: 0 };
      if (history.usd >= front.usd && history.usd >= compaction.usd) {
        const sizes = g.occurrences
          .filter((o) => o.shape === 'history' && o.cache !== undefined)
          .map((o) => o.cache?.readBefore ?? 0);
        const lo = Math.min(...sizes);
        const hi = Math.max(...sizes);
        const range =
          sizes.length === 0
            ? ''
            : lo === hi
              ? ` while the context sat at ${tok(lo)} tokens`
              : ` while the context sat between ${tok(lo)} and ${tok(hi)} tokens`;
        return {
          what: `${plural(history.count, 'time')} the conversation was re-written at the write premium${range} — ${formatUSD(history.usd)}.`,
          lever: custom
            ? 'Keep the history you re-send under ~200k tokens: summarize or drop what is no longer needed.'
            : '`/compact` before the context passes ~200k, or a new session per task, would have kept it.',
        };
      }
      if (front.usd >= compaction.usd) {
        return {
          what: `${plural(front.count, 'time')} the front of the prompt changed mid-session and the whole prefix was written again — ${formatUSD(front.usd)}.`,
          lever: custom
            ? 'Never change the system prompt or the tool list once a session runs.'
            : 'Connect MCP servers and switch model or settings at a task boundary, not mid-session.',
        };
      }
      return {
        what: `${plural(compaction.count, 'compaction')} each wrote a new prefix — ${formatUSD(compaction.usd)}.`,
        lever:
          'Compact earlier, while there is less to summarize, or start a new session per task.',
      };
    }
    case 'idle-cache-expiry':
      return {
        what: `${plural(g.count, 'idle gap')} let the cache expire; resuming re-wrote the prefix — ${usd}.`,
        lever: custom
          ? 'Use the 1-hour cache TTL and compact the history before an expected pause.'
          : '`/compact` before a long break, or start the next task in a new session.',
      };
    case 'retry-loop':
      return {
        what: `${plural(g.count, 'retry loop')} re-billed the whole context on every attempt — ${usd}.`,
        lever: `Interrupt when the same call fails twice and put the missing fact into ${instructionsFile(source)}.`,
      };
    case 'scattered-tool-failures':
      return {
        what: `Scattered tool failures each cost a model call to react — ${usd}.`,
        lever: `Record the fixes in ${instructionsFile(source)}, starting with the tool that failed most.`,
      };
    case 'dead-end-run':
      return {
        what: `The session ended on a failure; the calls after the last completed change bought nothing — ${usd}.`,
        lever:
          source === 'claude-code'
            ? 'Resume with `claude --continue` and deal with the failing step first.'
            : source === 'opencode'
              ? 'Resume with `opencode -c` and deal with the failing step first.'
              : 'Return the error to the caller and make the failed step the first thing the next run sees.',
      };
    case 'duplicate-read':
      return {
        what: `Unchanged files were re-read into the context — ${usd}.`,
        lever: 'Nothing to configure; shorter files make every read cheaper.',
      };
    default:
      return {
        what: `${g.label} — ${usd}.`,
        lever: playbookActions(g.ruleId, source)[0] ?? '',
      };
  }
}
