/**
 * render-playbooks.ts — regenerates the generated blocks in
 * docs/08-FINDINGS.md: "How to fix, rule by rule" from the rule playbooks in
 * packages/core/src/insights/meta.ts and "Errors, class by class" from the
 * error-class registry in packages/core/src/triage/meta.ts (the single
 * sources; the Inspector and the Errors tab render the same registries).
 *
 *   pnpm docs:playbooks          rewrite the blocks
 *   pnpm docs:playbooks --check  exit 1 when a committed block is stale
 *
 * Vitest drift tests perform the same check, so `pnpm test` fails when a
 * registry and the docs disagree.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ERROR_CLASSES_END,
  ERROR_CLASSES_START,
  extractBlock,
  PLAYBOOKS_END,
  PLAYBOOKS_START,
  renderErrorClassesMarkdown,
  renderPlaybooksMarkdown,
  replaceBlock,
} from '../packages/core/src/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const file = join(root, 'docs', '08-FINDINGS.md');
const doc = readFileSync(file, 'utf8');

const blocks = [
  {
    name: 'playbooks',
    start: PLAYBOOKS_START,
    end: PLAYBOOKS_END,
    block: renderPlaybooksMarkdown(),
  },
  {
    name: 'error-classes',
    start: ERROR_CLASSES_START,
    end: ERROR_CLASSES_END,
    block: renderErrorClassesMarkdown(),
  },
];

if (process.argv.includes('--check')) {
  let stale = false;
  for (const b of blocks) {
    if (extractBlock(doc, b.start, b.end) !== b.block) {
      console.error(
        `docs/08-FINDINGS.md: the ${b.name} block is stale — run \`pnpm docs:playbooks\``,
      );
      stale = true;
    }
  }
  if (stale) process.exit(1);
  console.log('docs/08-FINDINGS.md: generated blocks are up to date');
} else {
  let next = doc;
  for (const b of blocks) next = replaceBlock(next, b.start, b.end, b.block);
  writeFileSync(file, next);
  console.log('wrote the generated blocks to docs/08-FINDINGS.md');
}
