import { describe, expect, it } from 'vitest';
import {
  PLAYBOOK_SOURCES,
  playbookActions,
  RULE_META,
  ruleClass,
} from './meta.js';
import { V0_RULES } from './rules.js';

describe('rule metadata registry', () => {
  it('covers every registered rule', () => {
    for (const rule of V0_RULES) {
      expect(
        RULE_META[rule.id],
        `rule "${rule.id}" has no RULE_META entry`,
      ).toBeDefined();
    }
  });

  it('keeps the v0 waste classification (rollup-identical to before)', () => {
    expect(ruleClass('retry-loop')).toBe('waste');
    expect(ruleClass('dead-end-run')).toBe('waste');
    expect(ruleClass('low-cache-hit')).toBe('opportunity');
    expect(ruleClass('context-bloat')).toBe('opportunity');
    expect(ruleClass('expensive-subagent')).toBe('opportunity');
  });

  it('treats unknown rule ids as opportunity (open set)', () => {
    expect(ruleClass('some-future-rule')).toBe('opportunity');
  });

  it('every entry carries a label and explanation', () => {
    for (const [id, meta] of Object.entries(RULE_META)) {
      expect(meta.label.length, id).toBeGreaterThan(0);
      expect(meta.explain.length, id).toBeGreaterThan(0);
    }
  });

  it('every entry carries a complete playbook: causes, actions per source, limits', () => {
    for (const [id, meta] of Object.entries(RULE_META)) {
      const { causes, actions, limits } = meta.playbook;
      expect(causes.length, `${id} causes`).toBeGreaterThan(0);
      expect(limits.length, `${id} limits`).toBeGreaterThan(0);
      for (const source of PLAYBOOK_SOURCES) {
        expect(actions[source].length, `${id} ${source}`).toBeGreaterThan(0);
      }
      // one line each, no dangling backtick — the UI splits on backticks
      for (const line of [
        ...causes,
        ...limits,
        ...Object.values(actions).flat(),
      ]) {
        expect(line, `${id}: "${line}"`).not.toMatch(/\n/);
        expect((line.match(/`/g) ?? []).length % 2, `${id}: "${line}"`).toBe(0);
      }
    }
  });

  it('resolves playbook actions by source, falling back to the custom-agent list', () => {
    expect(playbookActions('retry-loop', 'claude-code')).toBe(
      RULE_META['retry-loop']?.playbook.actions['claude-code'],
    );
    expect(playbookActions('retry-loop', 'something-else')).toBe(
      RULE_META['retry-loop']?.playbook.actions.otlp,
    );
    expect(playbookActions('no-such-rule', 'claude-code')).toEqual([]);
  });
});
