import { contextCapEstimates } from '@runray/core/waste';
import type { Run } from '@runray/schema';
import { useMemo } from 'react';
import { formatUSD } from '../lib/format';
import { tok } from '../lib/waste';
import { useAppStore } from '../store';
import { InlineCode } from './PlaybookSteps';

/**
 * What the Growing context estimate is made of (visualizer "Waste tab" —
 * how context-bloat is counted): the baseline, the calls counted, the
 * excess tokens and the rate, said plainly as an upper bound against the
 * session's opening context; then the same formula with a ceiling in
 * place of the baseline — what keeping the context under 100k, 200k or
 * 400k tokens would have saved. The numbers come from core, never from a
 * UI-side reimplementation; without a pricing payload the tokens stand
 * and the amounts are absent.
 */
export function ContextBloatHow({ run }: { run: Run }) {
  const pricing = useAppStore((s) => s.pricing);
  const est = useMemo(
    () => contextCapEstimates(run, pricing?.table),
    [run, pricing],
  );
  if (est === undefined) {
    return (
      <p className="text-label text-text-faint">
        Upper bound: assumes the work could have continued from a compacted
        context.
      </p>
    );
  }
  const total = run.totals.costUSD.total;
  const share = (usd: number) =>
    total > 0 ? `${((usd / total) * 100).toFixed(0)}%` : '';

  return (
    <div className="grid gap-2">
      <p className="micro-label text-text-faint">How this is counted</p>
      <p className="text-label leading-[1.45] text-text-dim">
        Baseline: the median context of the first three model calls,{' '}
        <span className="font-mono text-text">{tok(est.baseline)}</span> tokens.
        Each of the <span className="font-mono text-text">{est.counted}</span>{' '}
        later calls re-paid whatever it carried above that:{' '}
        <span className="font-mono text-text">{tok(est.excess.tokens)}</span>{' '}
        tokens in total, priced at what each call actually paid per input-class
        token
        {est.ratePerMTok !== undefined && (
          <>
            {' '}
            (≈{' '}
            <span className="font-mono text-text">
              {formatUSD(est.ratePerMTok)}
            </span>{' '}
            per million here; cache reads where the context was served from
            cache)
          </>
        )}
        . An upper bound: it assumes the whole session could have run at its
        opening context.{' '}
        <InlineCode line="Nothing here assumes `/compact` at 200k." />
      </p>
      <p className="micro-label text-text-faint">
        Had the context never passed…
      </p>
      <table className="w-full max-w-[520px] border-collapse text-label">
        <thead>
          <tr className="micro-label text-text-faint">
            <th className="pb-1 text-left font-normal">ceiling</th>
            <th className="pb-1 text-right font-normal">excess</th>
            <th className="pb-1 text-right font-normal">saving</th>
            <th className="pb-1 text-right font-normal">of this session</th>
          </tr>
        </thead>
        <tbody>
          {est.caps.map((c) => (
            <tr key={c.cap} className="border-t border-border">
              <td className="py-1 font-mono text-text">{tok(c.cap)}</td>
              <td className="py-1 text-right font-mono text-text-dim">
                {tok(c.tokens)}
              </td>
              <td className="py-1 text-right font-mono text-cache-savings">
                {c.usd === undefined ? '—' : formatUSD(c.usd)}
              </td>
              <td className="py-1 text-right font-mono text-text-faint">
                {c.usd === undefined ? '' : share(c.usd)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-label text-text-faint">
        The same formula with the ceiling in place of the baseline; it ignores
        the cost of the compactions themselves and any re-reading after them.
        {pricing === undefined &&
          ' Amounts need the pricing payload this page does not carry (older export).'}
      </p>
    </div>
  );
}
