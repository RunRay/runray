import type { Run } from '@runray/schema';
import type { RunFilter } from './filter-runs';
import type { Route } from './router';

export type SanitizeProfile = 'full' | 'sanitized' | 'metadata-only';

export interface ExportCommandOptions {
  route: Route;
  filter?: RunFilter;
  allRuns?: readonly Run[];
  visibleRuns?: readonly Run[];
}

export interface ExportCommandResult {
  command: string;
  scopeSentence: string;
  runCount: number;
  hasStoreOnlyFilter: boolean;
}

/**
 * Pure command builder for dashboard export handoff (Task 4.1, D7, visualizer spec).
 * Returns the exact executable `runray export` command, the scope sentence, and run count.
 * Narrows to the active run id when viewing a single run.
 */
export function exportCommand(
  ctx: ExportCommandOptions,
  profile: SanitizeProfile,
): ExportCommandResult {
  const parts: string[] = ['runray', 'export'];
  const runId =
    'runId' in ctx.route &&
    typeof ctx.route.runId === 'string' &&
    ctx.route.runId
      ? ctx.route.runId
      : null;

  if (runId !== null) {
    parts.push(runId);
    parts.push('-o', 'report.html');
    if (profile === 'sanitized') {
      parts.push('--anonymize');
    } else if (profile === 'metadata-only') {
      parts.push('--metadata-only');
    }
    return {
      command: parts.join(' '),
      scopeSentence: 'Exports the single run currently in view.',
      runCount: 1,
      hasStoreOnlyFilter: false,
    };
  }

  // Multi-run overview
  parts.push('-o', 'report.html');
  const filter = ctx.filter;
  let hasStoreOnlyFilter = false;

  if (filter) {
    if (filter.source) {
      parts.push('--source', filter.source);
    }
    if (filter.periodDays !== null) {
      parts.push('--since', `${filter.periodDays}d`);
    }
    if (filter.project || filter.model || filter.day || filter.tool) {
      hasStoreOnlyFilter = true;
    }
  }

  if (profile === 'sanitized') {
    parts.push('--anonymize');
  } else if (profile === 'metadata-only') {
    parts.push('--metadata-only');
  }

  const allCount = ctx.allRuns?.length ?? 0;
  const visibleCount = ctx.visibleRuns?.length ?? allCount;

  let scopeSentence: string;
  if (hasStoreOnlyFilter) {
    scopeSentence = `Exports all ${allCount} runs matching CLI flags. Note: active in-browser filters (project, model, day, tool) have no CLI equivalent and are not applied.`;
  } else if (filter?.source && filter?.periodDays) {
    scopeSentence = `Exports all runs from ${filter.source} in the last ${filter.periodDays} days (${visibleCount} run${visibleCount === 1 ? '' : 's'}).`;
  } else if (filter?.source) {
    scopeSentence = `Exports all runs from ${filter.source} (${visibleCount} run${visibleCount === 1 ? '' : 's'}).`;
  } else if (filter?.periodDays) {
    scopeSentence = `Exports all runs from the last ${filter.periodDays} days (${visibleCount} run${visibleCount === 1 ? '' : 's'}).`;
  } else {
    scopeSentence = `Exports all ${allCount} discovered run${allCount === 1 ? '' : 's'}.`;
  }

  return {
    command: parts.join(' '),
    scopeSentence,
    runCount: hasStoreOnlyFilter ? allCount : visibleCount,
    hasStoreOnlyFilter,
  };
}
