# Tasks: fix-theme-tokens

Definition of done: `pnpm lint && pnpm typecheck && pnpm test` green, no schema drift, goldens in `fixtures/normalized/` byte-identical.

## 1. Theme tokens

- [x] 1.1 Elevation follows the theme [UI → /frontend-design]: `--shadow-card` and `--shadow-popover` in `@theme` keep their geometry and take their colours from `--elevation-*` variables, set in the base layer for ink and overridden for paper. The paper `--shadow-*` override, which never took effect, is removed. Guard in `packages/ui/src/theme-tokens.test.ts`: no literal colour in any `@theme` shadow, every colour variable set for both themes, and no literal colour in the built `.shadow-card` / `.shadow-popover` (skipped without a build).
- [x] 1.2 `text-faint` raised to AA [UI → /frontend-design]: `#85859d` in ink, `#636b78` in paper. Guard: in both themes, faint is at least 4.5:1 on `bg`, `bg-deep-gray`, `surface`, `surface-2` and `surface-container-low`, dim's contrast is at least 1.25 times faint's, and text is above dim.
- [x] 1.3 Faint on chip and tinted grounds [UI → /frontend-design]:
  - first pass: four call sites stepped up to dim, superseded by 2.1;
  - the top bar's status line and the filter placeholder move from `text-outline`, a border token, to `text-faint`;
  - `patch` changeset for `runray`.

## 2. Review follow-ups

- [x] 2.1 Faint on raised grounds [UI → /frontend-design]:
  - a base-layer rule re-points `--color-text-faint` to dim on `surface-variant`, `surface-container-high`/`-highest` (with their `hover:` variants) and heat tints up to 15%;
  - the call-site swaps from 1.3 are reverted, and the treemap's "+N nested" is set in the sans face to stay apart from the figure;
  - the guard fails when a component uses such a ground class missing from the rule, or when dim drops below 4.5:1 on a listed ground;
  - the guard also reads shadow colours per layer (so a named colour such as `black` fails) and skips a build older than `index.css`, but fails a fresh build that lacks the utilities.
- [x] 2.2 Ink shadows are tinted with the ink ground's hue instead of flat black. The top bar drops `transition-all` (motion guardrail).
- [x] 2.3 Browser audit of every faint, dim and outline text node, `aria-hidden` subtrees included, in both themes. It covers 27 states: 14 views, a selected span row and a selected Σ-rollup row in each of three runs, the highlighted evidence rows after an insight deep link, and an active tool row. Result: none below 4.5:1 (about 2,800 nodes in ink, 3,000 in paper). Elements faded with `opacity` (removed diff rows) are excluded and tracked separately.
