import { describe, expect, it } from 'vitest';
import { fuzzyRank, fuzzyScore } from './fuzzy';

describe('fuzzyScore', () => {
  it('matches an in-order subsequence, case-insensitive', () => {
    expect(fuzzyScore('cv', 'Cost view')).not.toBeNull(); // c…v, in order
    expect(fuzzyScore('COST', 'cost view')).not.toBeNull();
    // out-of-order characters never match: no 'c' follows the 'v' in "view"
    expect(fuzzyScore('vc', 'Cost view')).toBeNull();
    expect(fuzzyScore('zx', 'Cost view')).toBeNull();
  });

  it('is null when a character is missing', () => {
    expect(fuzzyScore('costly', 'Cost view')).toBeNull();
  });

  it('empty query is a neutral (zero) match, not null', () => {
    expect(fuzzyScore('', 'anything')).toBe(0);
    expect(fuzzyScore('   ', 'anything')).toBe(0);
  });

  it('scores a contiguous prefix above a scattered match', () => {
    const contiguous = fuzzyScore('cost', 'Cost view') as number;
    const scattered = fuzzyScore('cost', 'cross-run tool set') as number;
    expect(contiguous).toBeGreaterThan(scattered);
  });

  it('rewards a word-start match over a mid-word one', () => {
    // single char, so the greedy leftmost hit is the one that scores; the
    // first 'o' in each target is the one compared
    const wordStart = fuzzyScore('o', 'a open') as number; // first 'o' after a space
    const midWord = fuzzyScore('o', 'fo') as number; // first 'o' mid-word
    expect(wordStart).toBeGreaterThan(midWord);
  });
});

describe('fuzzyRank', () => {
  const items = ['Cost view', 'Timeline view', 'cross-run tool', 'compose'];

  it('orders by score, best first, dropping non-matches', () => {
    const ranked = fuzzyRank('cost', items, (s) => s);
    expect(ranked[0]).toBe('Cost view'); // contiguous prefix wins
    expect(ranked).not.toContain('Timeline view'); // no 'cost' subsequence
  });

  it('is stable — equal scores keep original order', () => {
    // both start with "c…" identically against a single-char query
    const ranked = fuzzyRank('c', ['cat', 'cot', 'cut'], (s) => s);
    expect(ranked).toEqual(['cat', 'cot', 'cut']);
  });

  it('returns every item (original order) for an empty query', () => {
    expect(fuzzyRank('', items, (s) => s)).toEqual(items);
  });
});
