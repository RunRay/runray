import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Run, Span } from '@runray/schema';
import { describe, expect, it } from 'vitest';
import { ACTIVITIES } from './registry.js';
import { type ToolRow, type ToolUsage, toolUsage } from './usage.js';

/**
 * Invariants of the aggregation over real shapes (tasks 3.3): every
 * committed golden, in all three export profiles. The unit tests cover
 * resolved identities with literal commands; this file proves the sums hold
 * on what the adapters actually emit, including shapes no test author
 * thought of.
 */

const fixturesDir = join(
  fileURLToPath(new URL('../../../..', import.meta.url)),
  'fixtures',
);
const PROFILES = ['normalized', 'sanitized', 'metadata-only'] as const;
type Profile = (typeof PROFILES)[number];

function jsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsonFiles(path));
    else if (entry.name.endsWith('.json')) out.push(path);
  }
  return out.sort();
}

interface Golden {
  profile: Profile;
  /** `claude-code/subagents.json`: the same name in every profile. */
  name: string;
  run: Run;
}

const goldens: Golden[] = PROFILES.flatMap((profile) => {
  const dir = join(fixturesDir, profile);
  return jsonFiles(dir).map((path) => ({
    profile,
    name: relative(dir, path).replace(/\\/g, '/'),
    run: JSON.parse(readFileSync(path, 'utf8')) as Run,
  }));
});

/** Tools that wait on the person, by name: the test's own copy of the rule. */
const HUMAN_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode', 'question']);

function isCall(span: Span): boolean {
  return span.kind === 'tool_call' || span.kind === 'mcp_call';
}

/** Summed tool time computed without the module under test (design T7). */
function independentSum(spans: readonly Span[]): number {
  const calls = new Set(spans.filter(isCall).map((s) => s.id));
  const containers = new Set(
    spans
      .filter((s) => s.kind === 'subagent' && s.parentId !== null)
      .map((s) => s.parentId as string)
      .filter((id) => calls.has(id)),
  );
  let total = 0;
  for (const span of spans) {
    if (!isCall(span) || containers.has(span.id)) continue;
    if (HUMAN_TOOLS.has(span.tool?.name ?? span.name)) continue;
    if (span.status === 'in_progress') continue;
    total += span.durationMs ?? 0;
  }
  return total;
}

const sum = (rows: readonly { totalMs: number }[]): number =>
  rows.reduce((acc, r) => acc + r.totalMs, 0);
const count = (rows: readonly { calls: number }[]): number =>
  rows.reduce((acc, r) => acc + r.calls, 0);

function allRows(usage: ToolUsage): ToolRow[] {
  return [
    ...usage.rows,
    ...usage.agents.rows,
    ...usage.hooks.rows,
    ...usage.waiting.rows,
  ];
}

/** What must be identical however the trace was redacted. */
function closedView(usage: ToolUsage) {
  const figures = (r: ToolRow) => ({
    id: r.id,
    calls: r.calls,
    errors: r.errors,
    totalMs: r.totalMs,
    sharedMs: r.sharedMs,
    alsoRanMs: r.alsoRanMs,
    flags: r.flags,
  });
  // a skill is named by free-form text, so its row key differs by design
  const skills = usage.rows.filter((r) => r.family === 'skill');
  return {
    summedMs: usage.summedMs,
    calls: usage.calls,
    activities: usage.activities,
    rows: usage.rows.filter((r) => r.family !== 'skill').map(figures),
    skills: { calls: count(skills), totalMs: sum(skills) },
    agents: { calls: usage.agents.calls, totalMs: usage.agents.totalMs },
    hooks: { calls: usage.hooks.calls, totalMs: usage.hooks.totalMs },
    waiting: usage.waiting.rows.map(figures),
    unclassifiedShellCalls: usage.unclassifiedShellCalls,
  };
}

describe('toolUsage over every committed golden', () => {
  it('finds goldens in all three profiles', () => {
    for (const profile of PROFILES) {
      expect(
        goldens.filter((g) => g.profile === profile).length,
        profile,
      ).toBeGreaterThan(0);
    }
  });

  for (const { profile, name, run } of goldens) {
    describe(`${profile}/${name}`, () => {
      const usage = toolUsage(run.spans);

      it('row totals sum to summed tool time', () => {
        expect(sum(usage.rows)).toBe(usage.summedMs);
        expect(usage.summedMs).toBe(independentSum(run.spans));
      });

      it('activity totals partition summed tool time', () => {
        expect(sum(usage.activities)).toBe(usage.summedMs);
        expect(count(usage.activities)).toBe(usage.calls);
        const order = usage.activities.map((a) =>
          ACTIVITIES.indexOf(a.activity),
        );
        expect(order).toEqual([...order].sort((a, b) => a - b));
        expect(usage.activities.map((a) => a.activity)).not.toContain('human');
      });

      it('accounts for every tool, MCP and hook span exactly once', () => {
        const calls = run.spans.filter(isCall).length;
        const hooks = run.spans.filter((s) => s.kind === 'hook').length;
        expect(count(usage.rows)).toBe(usage.calls);
        expect(usage.calls + usage.agents.calls + usage.waiting.calls).toBe(
          calls,
        );
        expect(usage.hooks.calls).toBe(hooks);
      });

      it('keeps every row consistent with its sub-rows', () => {
        const rows = allRows(usage);
        expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
        for (const row of rows) {
          expect(row.sharedMs, row.id).toBeLessThanOrEqual(row.totalMs);
          expect(row.p50Ms, row.id).toBeLessThanOrEqual(row.p95Ms);
          expect(row.p95Ms, row.id).toBeLessThanOrEqual(row.maxMs);
          expect(row.maxMs, row.id).toBeLessThanOrEqual(row.totalMs);
          expect(row.open + row.errors, row.id).toBeLessThanOrEqual(row.calls);
          if (row.subs.length === 0) continue;
          expect(sum(row.subs), row.id).toBe(row.totalMs);
          expect(count(row.subs), row.id).toBe(row.calls);
          expect(new Set(row.subs.map((s) => s.id)).size).toBe(row.subs.length);
        }
      });

      it('narrows to each activity without losing or adding time', () => {
        for (const { activity, totalMs, calls } of usage.activities) {
          const narrowed = toolUsage(run.spans, { activities: [activity] });
          expect(sum(narrowed.rows), activity).toBe(totalMs);
          expect(count(narrowed.rows), activity).toBe(calls);
        }
      });

      it('gives the same result whatever the span order', () => {
        expect(toolUsage([...run.spans].reverse())).toEqual(usage);
      });

      if (profile !== 'normalized') {
        it('carries no free-form detail', () => {
          for (const row of allRows(usage)) {
            for (const sub of row.subs) {
              expect(sub.detail, `${row.id} ${sub.id}`).toBeUndefined();
            }
          }
        });
      }

      if (profile === 'metadata-only') {
        it('has nothing to list: leaf spans are pruned', () => {
          expect(allRows(usage)).toEqual([]);
          expect(usage.summedMs).toBe(0);
        });
      }
    });
  }

  it('reports the same closed-vocabulary figures for a sanitized trace', () => {
    const sanitized = new Map(
      goldens.filter((g) => g.profile === 'sanitized').map((g) => [g.name, g]),
    );
    let compared = 0;
    for (const full of goldens.filter((g) => g.profile === 'normalized')) {
      const other = sanitized.get(full.name);
      if (other === undefined) continue;
      compared++;
      expect(closedView(toolUsage(other.run.spans)), full.name).toEqual(
        closedView(toolUsage(full.run.spans)),
      );
    }
    expect(compared).toBeGreaterThan(0);
  });

  it('exercises ranked rows, delegations and waiting somewhere', () => {
    const full = goldens
      .filter((g) => g.profile === 'normalized')
      .map((g) => toolUsage(g.run.spans));
    expect(full.some((u) => u.rows.length > 0)).toBe(true);
    expect(full.some((u) => u.agents.calls > 0)).toBe(true);
    expect(full.some((u) => u.waiting.calls > 0)).toBe(true);
    expect(full.some((u) => u.rows.some((r) => r.family === 'mcp'))).toBe(true);
  });

  it('finds every shell call of a transcript source classified', () => {
    // an OTLP tool span has a name and no command (design T10), so its
    // shell calls stay at the harness tool name; transcripts never do
    for (const { name, run } of goldens.filter(
      (g) => g.profile === 'normalized',
    )) {
      const unclassified = toolUsage(run.spans).unclassifiedShellCalls;
      if (name.startsWith('otlp/')) continue;
      expect(unclassified, name).toBe(0);
    }
    const otlp = goldens.filter(
      (g) => g.profile === 'normalized' && g.name.startsWith('otlp/'),
    );
    expect(
      otlp.some((g) => toolUsage(g.run.spans).unclassifiedShellCalls > 0),
    ).toBe(true);
  });
});
