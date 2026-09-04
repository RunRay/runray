import type { Insight } from '@runray/schema';
import { describe, expect, it } from 'vitest';
import { rankInsights } from './insight-order';

const finding = (
  id: string,
  severity: Insight['severity'],
  usd?: number,
): Insight => ({
  id,
  ruleId: 'retry-loop',
  severity,
  title: id,
  detail: '',
  spanIds: [],
  ...(usd === undefined ? {} : { estimatedWasteUSD: usd }),
});

describe('rankInsights', () => {
  it('orders by estimated waste, then severity, then id, without mutating', () => {
    const input = [
      finding('i1', 'info', 1),
      finding('i2', 'critical'),
      finding('i3', 'warning', 1),
      finding('i4', 'info', 30),
      finding('i5', 'warning'),
    ];
    const ranked = rankInsights(input).map((i) => i.id);
    expect(ranked).toEqual(['i4', 'i3', 'i1', 'i2', 'i5']);
    expect(input.map((i) => i.id)).toEqual(['i1', 'i2', 'i3', 'i4', 'i5']);
  });
});
