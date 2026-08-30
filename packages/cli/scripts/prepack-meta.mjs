/**
 * prepack: copy the repo-root README and LICENSE into the package.
 *
 * npm reads both only from the package directory, so without this the
 * published page on npmjs.com would be blank and the MIT grant declared in
 * package.json would ship without its text. Copying keeps a single source of
 * truth at the repo root instead of a second README that drifts.
 *
 * Names are matched case-insensitively on purpose: NTFS resolves README.md
 * to readme.md, so a case mismatch here would pass on Windows and fail the
 * release on the Linux runner.
 */
import { copyFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(cliRoot));

const entries = readdirSync(repoRoot);

for (const name of ['README.md', 'LICENSE']) {
  const actual = entries.find((f) => f.toLowerCase() === name.toLowerCase());
  if (actual === undefined) {
    console.error(`prepack: expected ${name} at the repo root`);
    process.exit(1);
  }
  copyFileSync(join(repoRoot, actual), join(cliRoot, name));
  console.log(`prepack: copied ${actual} -> packages/cli/${name}`);
}
