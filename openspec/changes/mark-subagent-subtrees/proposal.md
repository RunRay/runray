# Proposal: mark-subagent-subtrees

## Why

In a run that delegates heavily, with dozens of subagents and some nested inside others, the timeline waterfall doesn't separate the subagents' work from the orchestrator's (`packages/ui/src/components/Waterfall.tsx`).

- **Same colour as other bars.** The subagent bar is almost the same violet as the llm bar in ink (`#8b5cf6` against `#7c5cff`, OKLab ΔE 3), and almost the same grey as the tool bar in paper (`#374151` against `#4b5563`).
- **Nesting shows only in the indent.** Bars are placed by time across the full row, so the only sign that a span runs inside a subagent is the 16 px indent of its caret.
- **Collapsing hides findings.** "Collapse subagents" hides the finding marker of every span inside. A retry loop inside a subagent leaves no trace on the collapsed row. Its root shows only findings that name the root itself, such as `expensive-subagent`.

The subtree economics badge (Σ cost · tokens · calls), the `subagent:<type>` row labels and the "Collapse subagents" action already exist. This change adds what is still missing.

## What Changes

- **Subagent colour.** Chartreuse `#c7e02b` in ink and umber `#4f2b0a` in paper, chosen by a grid search over OKLCH. The search took the colour furthest from the other bars (llm, tool, mcp, hook, error) and from the warning colour of finding notches and chips, for normal vision and simulated protanopia and deuteranopia. The smallest distance is now about 14 (OKLab ΔE ×100), up from 1.6 in ink and 7.3 in paper.
  - Every use of `span-subagent` follows: bars, the Inspector and diff swatches, and the sessions-table badge.
  - `span-palette.test.ts` holds the distance at 12 or more, and the contrast at 4.5:1 or more, as a bar on the row ground and as badge text on its tint.
- **Delegation rails.** Every row inside a subagent carries a 2 px rail in the subagent colour for each enclosing subagent. The rail sits under that subagent's caret, so nested delegation reads as stacked rails. An expanded subagent starts its own rail just below its caret. Rails sit behind bars and labels.
- **Hidden findings on a collapsed row.** A collapsed row shows the findings whose evidence it hides:
  - a `⚠ N inside` chip tinted by the worst severity, with a hollow notch at the left edge;
  - their titles in the row's accessible name;
  - in the tooltip, the list with each finding's own estimate.

  Clicking the chip opens the worst finding the way a deep link does: the subtree expands and the view lands on its evidence. A finding that already marks the row itself is not counted again.
  - There is no dollar total. A finding's evidence can straddle the subtree's edge, and burned and opportunity estimates don't add up. The Waste tab owns totals.
  - This applies to any collapsed row, not only subagents, because collapsing a turn hides findings the same way.

## Impact

- Affected specs: visualizer (ADDED "Subagent subtrees stand apart in the waterfall").
- Affected code:
  - `packages/ui/src/index.css`
  - `packages/ui/src/lib/waterfall.ts`
  - `packages/ui/src/components/Waterfall.tsx`
  - their tests, plus `packages/ui/src/span-palette.test.ts`
- UI only: no schema change, no change in core, no new dependency. Goldens are unchanged.
