import { describe, expect, it } from 'vitest';
import { PLAYBOOK_SOURCES } from '../insights/meta.js';
import {
  ERROR_CLASS_IDS,
  ERROR_CLASS_META,
  ERROR_OWNER_META,
  ERROR_OWNER_ORDER,
  errorClassOwner,
} from './meta.js';

describe('error-class registry', () => {
  it('every class carries a label, an explanation and a known owner', () => {
    for (const id of ERROR_CLASS_IDS) {
      const meta = ERROR_CLASS_META[id];
      expect(meta.label.length, id).toBeGreaterThan(0);
      expect(meta.explain.length, id).toBeGreaterThan(0);
      expect(ERROR_OWNER_ORDER, `${id} owner`).toContain(meta.owner);
    }
  });

  it('every owner has a heading and a meaning', () => {
    for (const owner of ERROR_OWNER_ORDER) {
      expect(ERROR_OWNER_META[owner].label.length).toBeGreaterThan(0);
      expect(ERROR_OWNER_META[owner].meaning.length).toBeGreaterThan(0);
    }
  });

  it('every class carries a complete playbook: causes, actions per source, limits', () => {
    for (const id of ERROR_CLASS_IDS) {
      const { causes, actions, limits } = ERROR_CLASS_META[id].playbook;
      expect(causes.length, `${id} causes`).toBeGreaterThan(0);
      expect(limits.length, `${id} limits`).toBeGreaterThan(0);
      for (const source of PLAYBOOK_SOURCES) {
        expect(actions[source].length, `${id} ${source}`).toBeGreaterThan(0);
      }
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

  it('puts the person first and noise last', () => {
    expect(ERROR_OWNER_ORDER[0]).toBe('you');
    expect(ERROR_OWNER_ORDER[ERROR_OWNER_ORDER.length - 1]).toBe('unknown');
    expect(errorClassOwner('shell-syntax')).toBe('you');
    expect(errorClassOwner('check-failed')).toBe('work');
    expect(errorClassOwner('nope')).toBe('unknown');
  });
});
