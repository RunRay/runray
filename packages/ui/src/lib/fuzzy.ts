/**
 * Tiny subsequence fuzzy matcher for the command palette (D7 — internal, no
 * dependency). A query matches when its characters appear in order (not
 * necessarily contiguous) in the target; the score rewards contiguous runs and
 * word-start hits so "cost" ranks "Cost view" above a stray "cross-run…". Pure
 * and case-insensitive — `null` means no match, so callers can filter. Ties
 * break by original order (`fuzzyRank`), keeping results deterministic.
 */

/** Characters that begin a "word" — a match right after one scores higher. */
const WORD_BOUNDARY = /[\s·:/_.-]/;

export function fuzzyScore(query: string, target: string): number | null {
  const q = query.trim().toLowerCase();
  if (q === '') return 0; // empty query matches everything, neutral score
  const t = target.toLowerCase();
  let score = 0;
  let from = 0;
  let prev = -2; // < -1 so the first char is never counted as contiguous
  let streak = 0;
  for (const ch of q) {
    const at = t.indexOf(ch, from);
    if (at === -1) return null;
    if (at === prev + 1) {
      streak += 1;
      score += 4 + streak; // longer contiguous runs compound
    } else {
      streak = 0;
      score += 1;
    }
    if (at === 0 || WORD_BOUNDARY.test(t[at - 1] ?? '')) score += 3;
    score -= at * 0.02; // gentle nudge toward earlier matches
    prev = at;
    from = at + 1;
  }
  return score;
}

/**
 * Rank `items` by fuzzy match of `query` against `toText(item)`, best first,
 * dropping non-matches. Stable: equal scores keep their original order, so the
 * palette never reshuffles between identical queries.
 */
export function fuzzyRank<T>(
  query: string,
  items: readonly T[],
  toText: (item: T) => string,
): T[] {
  const scored: { item: T; index: number; score: number }[] = [];
  items.forEach((item, index) => {
    const score = fuzzyScore(query, toText(item));
    if (score !== null) scored.push({ item, index, score });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((s) => s.item);
}
