import { formatTokensCompact, formatUSD } from './format';

/**
 * Display unit (E6): the unit the headline figures lead with. Dollars are
 * computed at API list prices; tokens are what a subscriber's limit is made
 * of, and that person is never billed those dollars. A display choice only —
 * no figure is recomputed. Estimates that exist only in dollars (waste,
 * savings, what-if) stay in dollars and read "at API prices" in token mode,
 * because a cache or model-choice estimate is a price difference with no
 * token count behind it. Independent of limit mode (E1), which sets its
 * percentages in whichever unit is active.
 */
export type DisplayUnit = 'usd' | 'tokens';

export const UNIT_STORAGE_KEY = 'runray.unit';

/** The wording every dollar figure carries in token mode. */
export const AT_API_PRICES = 'at API prices';

export function storedUnit(): DisplayUnit {
  try {
    return localStorage.getItem(UNIT_STORAGE_KEY) === 'tokens'
      ? 'tokens'
      : 'usd';
  } catch {
    // no storage (tests, file:// in a locked-down browser): dollars
    return 'usd';
  }
}

export function persistUnit(unit: DisplayUnit): void {
  try {
    localStorage.setItem(UNIT_STORAGE_KEY, unit);
  } catch {
    // the choice still applies for this page; it just won't survive a reload
  }
}

/** Anything measured both ways: a run, a day, a ranking row, a tool. */
export interface Figure {
  costUSD: number;
  tokens: number;
}

/** The figure's value in the display unit — what leads, sorts and sizes. */
export function inUnit(unit: DisplayUnit, figure: Figure): number {
  return unit === 'tokens' ? figure.tokens : figure.costUSD;
}

/**
 * One figure in the display unit: `$12.41`, or `382.9M` for tokens. Rows
 * under a heading that names the unit leave the count bare; a figure
 * standing on its own (a list row, a hint, a tooltip) passes `named` and
 * reads `382.9M tokens`.
 */
export function formatFigure(
  unit: DisplayUnit,
  figure: Figure,
  { named = false }: { named?: boolean } = {},
): string {
  if (unit === 'usd') return formatUSD(figure.costUSD);
  const count = formatTokensCompact(figure.tokens);
  return named ? `${count} tokens` : count;
}
