import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  extractPlaybooksBlock,
  renderPlaybooksMarkdown,
  replacePlaybooksBlock,
} from './playbook-markdown.js';

/**
 * docs/08-FINDINGS.md carries a generated block rendered from RULE_META;
 * this keeps the committed docs equal to the registry (regenerate with
 * `pnpm docs:playbooks`), the same contract the JSON schema has with its
 * zod source.
 */

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const docPath = join(repoRoot, 'docs', '08-FINDINGS.md');

describe('findings docs ↔ rule playbooks', () => {
  it('docs/08-FINDINGS.md carries the block the registry renders', () => {
    const doc = readFileSync(docPath, 'utf8');
    const committed = extractPlaybooksBlock(doc);
    expect(committed, 'playbook markers missing').toBeDefined();
    expect(committed, 'stale playbooks block — run `pnpm docs:playbooks`').toBe(
      renderPlaybooksMarkdown(),
    );
  });

  it('renders one section per rule with all three sources', () => {
    const block = renderPlaybooksMarkdown();
    expect(block).toContain('### `retry-loop` · Repeated failing tool calls');
    expect(block).toContain('### `oversized-output` · Oversized tool output');
    expect(block).toContain('*Claude Code*');
    expect(block).toContain('*OpenCode*');
    expect(block).toContain('*Custom agent (OTLP)*');
  });

  it('replaces exactly the block between the markers', () => {
    const doc =
      'before\n<!-- playbooks:start -->\nold\n<!-- playbooks:end -->\nafter\n';
    const next = replacePlaybooksBlock(doc, 'new\n');
    expect(next).toBe(
      'before\n<!-- playbooks:start -->\nnew\n<!-- playbooks:end -->\nafter\n',
    );
    expect(extractPlaybooksBlock(next)).toBe('new\n');
    expect(() => replacePlaybooksBlock('no markers', 'x')).toThrow();
  });
});
