# Proposal: fix-theme-tokens

## Why

Two token bugs in `packages/ui/src/index.css` make the dashboard harder to read.

- **Paper cards wear ink's shadow.** Every panel and KPI card in the paper theme shows a dark rim along its bottom and right edges: ink's 35% black card shadow (50% on popovers). Tailwind v4 copies each `@theme` `--shadow-*` value into its utility at build time (`.shadow-card { --tw-shadow: 0 1px 0 var(--tw-shadow-color, #00000059), … }`), so the paper override of `--shadow-card` under `:root[data-theme="light"]` is never read.
- **Faint text fails WCAG AA.** `text-faint`, the lowest text tier, appears about 200 times, often at the 10.5px micro-label size. It measures about 3.3–3.8:1 in ink (`#6b6b80`) and 2.3–2.5:1 in paper (`#9ca3af`), against the 4.5:1 that AA asks of normal text. The theme requirement keeps both themes at "the stylebook's contrast floor", but the stylebook (`docs/03-design.md`) was removed in the dashboard redesign, so no floor is written down anywhere.

## What Changes

- **Elevation:** the `@theme` shadows keep their geometry, and their colours become `var()` references: `--elevation-card-edge`, `--elevation-card-drop`, `--elevation-popover-near` and `--elevation-popover-far`. The base layer sets them for ink and overrides them for paper.
  - Ink keeps its strength and is now tinted with its ground's hue instead of flat black.
  - Paper gets its designed slate-tinted shadows: 4% and 8% on cards, 12% and 16% on popovers. They use ink's offsets and blurs, because only colours can vary by theme. The old paper override's blurs were slightly tighter (18px instead of 22px on cards).
- **Faint on page and panel grounds:** `text-faint` becomes `#85859d` in ink and `#636b78` in paper. That clears 4.5:1 on `bg`, `bg-deep-gray`, `surface`, `surface-2` and `surface-container-low` in both themes, while `text-dim` stays about 1.4 times faint's contrast.
- **Faint on raised grounds:** a base-layer rule re-points `--color-text-faint` to dim on raised and tinted grounds, where faint can't reach 4.5:1 (3.43:1 on ink's `surface-variant`).
  - Raised grounds are `surface-variant` and `surface-container-high`/`-highest`, plus their `hover:` variants. Tinted grounds are heat tints up to 15%.
  - In the UI, that covers selected span rows, active run tabs, active tool rows, the sessions table head, cost treemap cells, added rows in the run diff, and highlighted evidence rows.
  - Every label inside renders at dim without each component choosing.
  - In the treemap, "+N nested" is now set in the sans face, so it stays apart from the mono figure now that both render at dim.
- **Smaller fixes:**
  - The top bar's status line and the timeline filter's placeholder used `text-outline`, a border token at 2.5:1 in paper. They now use `text-faint`.
  - The top bar drops `transition-all`, against the motion guardrail.
- **Guard:** `packages/ui/src/theme-tokens.test.ts` checks the token sheet. It fails when:
  - a shadow layer's colour isn't a per-theme `var()`;
  - faint drops below AA on a page or panel ground;
  - a raised or tinted ground class used in a component is missing from the re-point rule;
  - dim drops below AA on any ground that rule lists.

## Impact

- Affected specs: visualizer (ADDED "Theme tokens hold in both themes", which also gives the theme requirement's contrast floor a concrete value).
- Affected code:
  - `packages/ui/src/index.css`
  - `packages/ui/src/components/{NestedTreemap,TopBar,Waterfall}.tsx`
  - the new test
- No schema change, no new dependency, goldens unchanged.
- Out of scope, tracked separately:
  - Paper's semantic colours on light grounds measure about 2.9–4.3:1 at 10.5–13px: heat, cache savings, brand, and the critical and warning badges.
  - Ink's brand, violet and red text on its own chips measures about 3.6–4.3:1.
  - Removed rows in the run diff are drawn at 50% opacity.
