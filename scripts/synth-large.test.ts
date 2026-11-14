import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { codexAdapter } from '../packages/core/src/adapters/codex.js';
import { codexSynthSourcePath, synthesizeCodex } from './synth-large.js';

/**
 * The Codex perf fixture the bench makes for itself (fixtures/codex/large,
 * Option B). It is only worth timing if the adapter reads every copy as new
 * work: a rollout repeated as it is starts each turn and makes each call a
 * second time under the same id, and those are read once.
 */

const dir = mkdtempSync(join(tmpdir(), 'runray-synth-codex-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function parsed(name: string, text: string) {
  // a folder of its own: both files are the same thread
  const folder = mkdtempSync(join(dir, 'case-'));
  writeFileSync(join(folder, name), text);
  const [candidate] = await codexAdapter.detect([folder]);
  if (candidate === undefined) throw new Error('not a rollout candidate');
  return codexAdapter.parse(candidate, { redact: true });
}

const kinds = (spans: ReadonlyArray<{ kind: string }>) => {
  const count: Record<string, number> = {};
  for (const span of spans) count[span.kind] = (count[span.kind] ?? 0) + 1;
  return count;
};

describe('synthesizeCodex', () => {
  const source = readFileSync(codexSynthSourcePath(), 'utf8');
  // just over twice the source: three copies
  const big = synthesizeCodex(source, Math.round(source.length * 2.2));

  it('keeps the source as its first copy and grows to the size asked for', () => {
    expect(big.startsWith(source.trimEnd())).toBe(true);
    expect(big.length).toBeGreaterThan(source.length * 2.2);
    expect(big.length).toBeLessThan(source.length * 3.1);
    expect(big.split('\n')[0]).toContain('SCRUBBED');
    expect(big.match(/"type":"session_meta"/g)).toHaveLength(1);
  });

  it('reads as one thread with every copy’s turns, calls and tools', async () => {
    const one = await parsed('rollout-one.jsonl', source);
    const three = await parsed('rollout-three.jsonl', big);

    const once = kinds(one.spans);
    const thrice = kinds(three.spans);
    expect(thrice.session).toBe(1);
    for (const kind of ['turn', 'llm_call', 'tool_call', 'mcp_call'])
      expect(thrice[kind], kind).toBe((once[kind] ?? 0) * 3);
    expect(new Set(three.spans.map((s) => s.id)).size).toBe(three.spans.length);
    expect(three.warnings).toEqual([]);

    // three times the tokens, and the copies follow one another in time
    const tokens = (run: typeof one) =>
      run.spans.reduce((sum, s) => sum + (s.llm?.tokens.input ?? 0), 0);
    expect(tokens(three)).toBe(tokens(one) * 3);
    const turns = three.spans.filter((s) => s.kind === 'turn');
    const starts = turns.map((s) => s.startedAt);
    expect(starts).toEqual([...starts].sort());
    expect(new Set(starts).size).toBe(starts.length);
  });

  it('returns the source alone for a target it already meets', () => {
    expect(synthesizeCodex(source, 1)).toBe(`${source.trimEnd()}\n`);
  });
});
