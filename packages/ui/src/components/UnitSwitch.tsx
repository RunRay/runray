import type { DisplayUnit } from '../lib/unit';
import { useAppStore } from '../store';

const OPTIONS: { unit: DisplayUnit; label: string; title: string }[] = [
  {
    unit: 'usd',
    label: 'USD',
    title: 'Lead with dollars, at API list prices',
  },
  {
    unit: 'tokens',
    label: 'tokens',
    title:
      'Lead with token counts. Waste and savings stay in dollars, at API prices.',
  },
];

/**
 * TopBar unit switch (E6): which unit the headline figures lead with. Sits
 * beside the %win toggle and speaks its visual language — the chosen unit
 * takes the same brass tint as an enabled limit mode.
 */
export function UnitSwitch() {
  const unit = useAppStore((s) => s.unit);
  const setUnit = useAppStore((s) => s.setUnit);
  return (
    <fieldset
      aria-label="Unit for figures"
      className="m-0 inline-flex overflow-hidden rounded-control border border-border-slate bg-surface p-0"
    >
      {OPTIONS.map((o, i) => {
        const on = unit === o.unit;
        return (
          <button
            key={o.unit}
            type="button"
            aria-pressed={on}
            title={o.title}
            onClick={() => setUnit(o.unit)}
            className={`px-2 py-0.5 font-mono text-label transition-colors duration-150 ease-out focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brass active:bg-bg-deep-gray ${
              i > 0 ? 'border-l border-border-slate' : ''
            } ${
              on
                ? 'bg-brass/15 text-text'
                : 'text-text-dim hover:bg-surface-variant hover:text-text'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </fieldset>
  );
}
