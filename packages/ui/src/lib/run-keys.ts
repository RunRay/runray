import type { Run } from '@runray/schema';

/**
 * The grouping keys that rankings and filters share. A ranking row and the
 * filter it sets must agree on which runs belong together, so both read
 * them from here; runs without a value group under one `—` placeholder.
 */

/**
 * The one project grouping key: runs without a project name group under the
 * same `—` placeholder the overview ranking renders — clicking that row must
 * filter to exactly the runs it counted.
 */
export function projectKey(run: Run): string {
  return run.project?.name ?? '—';
}

/** Runs without a recorded branch share this key (and one ranking row). */
export const NO_BRANCH = '—';

/** The branch grouping key, the same placeholder rule as `projectKey`. */
export function branchKey(run: Run): string {
  return run.project?.gitBranch ?? NO_BRANCH;
}
