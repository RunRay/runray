# Tasks: fix-theme-tokens

Definition of done: `pnpm lint && pnpm typecheck && pnpm test` green, no schema drift, goldens in `fixtures/normalized/` byte-identical.

## 1. Theme tokens

- [x] 1.1 Elevation follows the theme [UI → /frontend-design]: `--shadow-card` and `--shadow-popover` in `@theme` keep their geometry and take their colours from `--elevation-*` variables, set in the base layer for ink and overridden for paper. The paper `--shadow-*` override, which never took effect, is removed. Guard in `packages/ui/src/theme-tokens.test.ts`: no literal colour in any `@theme` shadow, every colour variable set for both themes, and no literal colour in the built `.shadow-card` / `.shadow-popover` (skipped without a build).
- [x] 1.2 `text-faint` raised to AA [UI → /frontend-design]: `#85859d` in ink, `#636b78` in paper. Guard: in both themes, faint is at least 4.5:1 on `bg`, `bg-deep-gray`, `surface`, `surface-2` and `surface-container-low`, dim's contrast is at least 1.25 times faint's, and text is above dim.
- [x] 1.3 Faint text on chip and tinted grounds steps up to dim [UI → /frontend-design]:
  - covers inactive sort headers in the sessions table, "+N nested" in cost treemap cells, own duration on added rows in the run diff, and the timeline filter's placeholder while hovered;
  - the top bar's status line and the filter placeholder move from `text-outline`, a border token, to `text-faint`;
  - browser audit of every faint, dim and outline text node in 14 views, in both themes: none below 4.5:1;
  - `patch` changeset for `runray`.
