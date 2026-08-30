import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * Dev-only stand-in for the CLI server (05-ARCHITECTURE §3): serves the
 * scrubbed goldens from `fixtures/normalized/` as `GET /api/tracefile` so
 * `pnpm dev` exercises the real fetch path with real data before the CLI
 * embeds the dist (task 5.1). Never part of the build output.
 */
function devTraceFile(): Plugin {
  return {
    name: 'runray-dev-tracefile',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/tracefile', (_req, res) => {
        const goldensDir = fileURLToPath(
          new URL('../../fixtures/normalized', import.meta.url),
        );
        const runs: { startedAt: string }[] = [];
        for (const source of readdirSync(goldensDir)) {
          const sourceDir = join(goldensDir, source);
          for (const file of readdirSync(sourceDir)) {
            if (!file.endsWith('.json')) continue;
            runs.push(JSON.parse(readFileSync(join(sourceDir, file), 'utf8')));
          }
        }
        // Same ordering the CLI produces: newest first.
        runs.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            schemaVersion: '0.1.0',
            generator: { name: 'runray-ui-dev', version: '0.0.0' },
            generatedAt: new Date().toISOString(),
            runs,
          }),
        );
      });
    },
  };
}

export default defineConfig({
  define: {
    __RUNRAY_ONBOARDING__: 'true',
    __TRACEPULSE_ONBOARDING__: 'true',
  },
  plugins: [react(), tailwindcss(), devTraceFile()],
});
