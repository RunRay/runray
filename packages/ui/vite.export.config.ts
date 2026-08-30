import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * Export template (05-ARCHITECTURE §3, ADR-5): one self-contained
 * `dist-export/index.html` with all JS, CSS, and fonts inlined so a report
 * renders offline from `file://`. `runray export` injects
 * `window.__RUNRAY_DATA__` into it — the app then never fetches.
 */
export default defineConfig({
  define: {
    __RUNRAY_ONBOARDING__: 'false',
    __TRACEPULSE_ONBOARDING__: 'false',
  },
  plugins: [react(), tailwindcss(), viteSingleFile()],
  build: {
    outDir: 'dist-export',
  },
});
