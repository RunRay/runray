# Delta for visualizer

## ADDED Requirements

### Requirement: Theme tokens hold in both themes
The system SHALL draw card and popover elevation with the active theme's shadow colours. In both themes, tertiary text (`text-faint`) SHALL reach WCAG AA contrast, at least 4.5:1, on the page and panel grounds: `bg`, `bg-deep-gray`, `surface`, `surface-2` and `surface-container-low`.

- **Raised and tinted grounds.** On these grounds, tertiary text SHALL render as `text-dim`. Raised grounds are `surface-variant` and `surface-container-high`/`-highest`, as used by selected rows, active tabs, chips and table heads. Tinted grounds are the heat tints used by rows and cells.
- **Dim reaches AA.** `text-dim` SHALL reach 4.5:1 on every raised and tinted ground.
- **Visible tiers.** On the page and panel grounds, `text-dim`'s contrast SHALL be at least 1.25 times faint's.

This is the contrast floor that "Theme selection" refers to.

#### Scenario: Paper cards use paper elevation
- GIVEN the paper theme
- WHEN the dashboard renders its overview panel and KPI cards
- THEN their shadow uses paper's slate shadow colours at 4–8% opacity, not ink's black at 35%

#### Scenario: Ink elevation unchanged in strength
- GIVEN the ink theme
- WHEN the same panels render
- THEN their shadow keeps ink's 35% strength, tinted with the ink ground's hue

#### Scenario: Faint labels readable on panels
- GIVEN either theme
- WHEN a `text-faint` label sits on the page or on a panel
- THEN its contrast with that ground is at least 4.5:1

#### Scenario: Selected row steps up to dim
- GIVEN the ink theme and a run timeline
- WHEN the user selects a span whose row shows a Σ rollup in `text-faint`
- THEN the row turns `surface-variant`, the rollup renders as `text-dim`, and its contrast with the row is at least 4.5:1

#### Scenario: Tinted row steps up to dim
- GIVEN either theme and a run diff with an added span
- WHEN its row shows the span's own duration on the amber "added" tint
- THEN the duration renders as `text-dim`, and its contrast with the row is at least 4.5:1
