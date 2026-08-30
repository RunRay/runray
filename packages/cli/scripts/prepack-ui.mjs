/**
 * prepack (05-ARCHITECTURE §3): build the UI and copy both build outputs plus
 * the scrubbed goldens (the `runray demo` sample data) into cli/assets/ so
 * the published cli package is self-sufficient while @runray/ui stays
 * private.
 */
import { execSync } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(cliRoot));
const uiRoot = join(repoRoot, 'packages', 'ui');

// `@runray/ui build` produces both: dist (served by `view`) and
// dist-export (template for `export`).
execSync('pnpm --filter @runray/ui build', {
  cwd: repoRoot,
  stdio: 'inherit',
});

const copies = [
  {
    from: join(uiRoot, 'dist'),
    to: join(cliRoot, 'assets', 'ui'),
    marker: 'index.html',
  },
  {
    from: join(uiRoot, 'dist-export'),
    to: join(cliRoot, 'assets', 'ui-export'),
    marker: 'index.html',
  },
  {
    from: join(repoRoot, 'fixtures', 'normalized'),
    to: join(cliRoot, 'assets', 'demo'),
    marker: join('claude-code', 'subagents.json'),
  },
];
for (const { from, to, marker } of copies) {
  if (!existsSync(join(from, marker))) {
    console.error(`prepack: expected ${marker} under ${from}`);
    process.exit(1);
  }
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
  console.log(`prepack: copied ${from} -> ${to}`);
}
