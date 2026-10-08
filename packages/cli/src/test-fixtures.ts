import { inject } from 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Set by vitest.global-setup.ts at the repo root. */
    claudeCodeFixtures: string;
  }
}

/**
 * The committed claude-code fixtures (simple, subagents, tool-errors, …)
 * without the machine-local perf fixture, as one directory to scan. Use it
 * instead of `fixtures/claude-code` in any test that scans the whole
 * directory, so the runs it sees are the same on every machine.
 */
export function claudeCodeFixtures(): string {
  return inject('claudeCodeFixtures');
}
