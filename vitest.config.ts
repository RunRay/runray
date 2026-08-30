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
    environment: 'node',
  },
});
