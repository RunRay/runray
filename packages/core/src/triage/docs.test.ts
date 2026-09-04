import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractBlock } from '../insights/playbook-markdown.js';
import {
  ERROR_CLASSES_END,
  ERROR_CLASSES_START,
  renderErrorClassesMarkdown,
} from './markdown.js';

/**
 * docs/08-FINDINGS.md carries a second generated block, rendered from
 * ERROR_CLASS_META; same drift contract as the rule playbooks
 * (regenerate with `pnpm docs:playbooks`).
 */

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const docPath = join(repoRoot, 'docs', '08-FINDINGS.md');

describe('findings docs ↔ error classes', () => {
  it('docs/08-FINDINGS.md carries the block the registry renders', () => {
    const doc = readFileSync(docPath, 'utf8');
    const committed = extractBlock(doc, ERROR_CLASSES_START, ERROR_CLASSES_END);
    expect(committed, 'error-class markers missing').toBeDefined();
    expect(
      committed,
      'stale error-classes block — run `pnpm docs:playbooks`',
    ).toBe(renderErrorClassesMarkdown());
  });

  it('renders every owner group and every class', () => {
    const block = renderErrorClassesMarkdown();
    expect(block).toContain('### Yours to fix');
    expect(block).toContain('### Expected feedback');
    expect(block).toContain('#### `shell-syntax` · Shell syntax');
    expect(block).toContain('#### `pane-timeout` · Browser pane timeout');
    expect(block).toContain('*Custom agent (OTLP)*');
  });
});
