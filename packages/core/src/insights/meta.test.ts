import { describe, expect, it } from 'vitest';
import { RULE_META, ruleClass } from './meta.js';
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
});
