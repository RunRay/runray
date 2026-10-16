import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Workspace packages resolve to their TS sources so tests never depend on a
// prior `tsc --build` (dist may be stale or absent).
export default defineConfig({
  define: {
    __RUNRAY_ONBOARDING__: 'true',
    __TRACEPULSE_ONBOARDING__: 'true',
  },
  resolve: {
    alias: {
      '@runray/schema': fileURLToPath(
        new URL('./packages/schema/src/index.ts', import.meta.url),
      ),
      '@tracepulse/schema': fileURLToPath(
        new URL('./packages/schema/src/index.ts', import.meta.url),
      ),
      // browser-safe subpaths first — the bare alias would otherwise
      // swallow them as `<index.ts>/pricing`
      '@runray/core/pricing': fileURLToPath(
        new URL('./packages/core/src/pricing/engine.ts', import.meta.url),
      ),
      '@tracepulse/core/pricing': fileURLToPath(
        new URL('./packages/core/src/pricing/engine.ts', import.meta.url),
      ),
      '@runray/core/insights-meta': fileURLToPath(
        new URL('./packages/core/src/insights/meta.ts', import.meta.url),
      ),
      '@tracepulse/core/insights-meta': fileURLToPath(
        new URL('./packages/core/src/insights/meta.ts', import.meta.url),
      ),
      '@runray/core/diff': fileURLToPath(
        new URL('./packages/core/src/diff/index.ts', import.meta.url),
      ),
      '@tracepulse/core/diff': fileURLToPath(
        new URL('./packages/core/src/diff/index.ts', import.meta.url),
      ),
      '@runray/core/triage': fileURLToPath(
        new URL('./packages/core/src/triage/index.ts', import.meta.url),
      ),
      '@tracepulse/core/triage': fileURLToPath(
        new URL('./packages/core/src/triage/index.ts', import.meta.url),
      ),
      '@runray/core/waste': fileURLToPath(
        new URL('./packages/core/src/waste/index.ts', import.meta.url),
      ),
      '@tracepulse/core/waste': fileURLToPath(
        new URL('./packages/core/src/waste/index.ts', import.meta.url),
      ),
      '@runray/core': fileURLToPath(
        new URL('./packages/core/src/index.ts', import.meta.url),
      ),
      '@tracepulse/core': fileURLToPath(
        new URL('./packages/core/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.{ts,tsx}'],
    // hermetic copy of the committed claude-code fixtures (no local perf file)
    globalSetup: ['./vitest.global-setup.ts'],
    environment: 'node',
    pool: 'forks',
    // Vitest 4 removed `poolOptions.forks.maxForks` and ignored it silently
    // apart from a deprecation line; the cap is a top-level option now.
    maxWorkers: 4,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
