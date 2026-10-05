# Delta for visualizer

## ADDED Requirements

### Requirement: Theme tokens hold in both themes
The system SHALL draw card and popover elevation with the active theme's shadow colours. In both themes, tertiary text (`text-faint`) SHALL reach WCAG AA contrast, at least 4.5:1, on the page and panel grounds: `bg`, `bg-deep-gray`, `surface`, `surface-2` and `surface-container-low`.

- **Chip and tinted grounds.** Text on a chip or tinted ground where faint would fall below 4.5:1 SHALL use `text-dim` instead.
- **Visible tiers.** On each of those grounds, `text-dim`'s contrast SHALL be at least 1.25 times faint's.

This is the contrast floor that "Theme selection" refers to.

#### Scenario: Paper cards use paper elevation
- GIVEN the paper theme
- WHEN the dashboard renders its overview panel and KPI cards
- THEN their shadow uses paper's slate shadow colours at 4–8% opacity, not ink's black at 35%

#### Scenario: Ink elevation unchanged
- GIVEN the ink theme
- WHEN the same panels render
- THEN their shadow is ink's black at 35%, as before

#### Scenario: Faint labels readable on panels
- GIVEN either theme
- WHEN a `text-faint` label sits on the page or on a panel
- THEN its contrast with that ground is at least 4.5:1

#### Scenario: Tinted row steps up to dim
- GIVEN either theme and a run diff with an added span
- WHEN its row shows the span's own duration on the amber "added" tint
- THEN the duration uses `text-dim`, and its contrast with the row is at least 4.5:1
