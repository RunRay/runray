/**
 * render-playbooks.ts — regenerates the "How to fix, rule by rule" block in
 * docs/08-FINDINGS.md from the rule playbooks in
 * packages/core/src/insights/meta.ts (the single source; the Inspector
 * renders the same registry).
 *
 *   pnpm docs:playbooks          rewrite the block
 *   pnpm docs:playbooks --check  exit 1 when the committed block is stale
 *
 * A vitest drift test performs the same check, so `pnpm test` fails when
 * the registry and the docs disagree.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractPlaybooksBlock,
  renderPlaybooksMarkdown,
  replacePlaybooksBlock,
} from '../packages/core/src/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const file = join(root, 'docs', '08-FINDINGS.md');
const doc = readFileSync(file, 'utf8');
const block = renderPlaybooksMarkdown();

if (process.argv.includes('--check')) {
  if (extractPlaybooksBlock(doc) !== block) {
    console.error(
      'docs/08-FINDINGS.md: the playbooks block is stale — run `pnpm docs:playbooks`',
    );
    process.exit(1);
  }
  console.log('docs/08-FINDINGS.md: playbooks block is up to date');
} else {
  writeFileSync(file, replacePlaybooksBlock(doc, block));
  console.log('wrote the playbooks block to docs/08-FINDINGS.md');
}
