import type { Run } from '@runray/schema';

/**
 * The grouping keys that rankings and filters share. A ranking row and the
 * filter it sets must agree on which runs belong together, so both read
 * them from here; runs without a value group under one placeholder.
 */

/**
 * The one project grouping key: runs without a project name group under the
 * same `—` placeholder the overview ranking renders — clicking that row must
 * filter to exactly the runs it counted.
 */
export function projectKey(run: Run): string {
  return run.project?.name ?? '—';
}

/**
 * Runs without a recorded branch share this key (one ranking row, one
 * filter value, `?branch=~none` in a link). Git refuses `~` in a branch
 * name, so no recorded branch can equal it; a placeholder that a branch
 * could be named (`—` is a valid one) would merge that branch with the
 * runs that have none.
 */
export const NO_BRANCH = '~none';

/** The branch grouping key: the recorded branch, or `NO_BRANCH` when there
 * is none (an empty string from a foreign trace file counts as none). */
export function branchKey(run: Run): string {
  const branch = run.project?.gitBranch;
  return branch === undefined || branch === '' ? NO_BRANCH : branch;
}
