# Tasks: mark-subagent-subtrees

Definition of done: `pnpm lint && pnpm typecheck && pnpm test` green, no schema drift, goldens in `fixtures/normalized/` byte-identical.

## 1. Waterfall

- [x] 1.1 Subagent colour [UI → /frontend-design]: `--color-span-subagent` becomes `#c7e02b` in ink and `#4f2b0a` in paper. Guard in `packages/ui/src/span-palette.test.ts`, in both themes:
  - OKLab ΔE of at least 12 from llm, tool, mcp, hook, error and heat-2, for normal vision, protanopia and deuteranopia;
  - at least 4.5:1 on `surface-container-low`;
  - at least 4.5:1 as text on its own 12% tint, the sessions-table badge.

  The old colours fail 7 of the 8 cases.
- [x] 1.2 Delegation rails [UI → /frontend-design]: `subagentRails` in `packages/ui/src/lib/waterfall.ts` gives each span the depths of its enclosing subagents. `Waterfall.tsx` draws a 2 px rail per depth under that depth's caret, and starts an expanded subagent's own rail below its caret. Tests: nested subagents, a subagent's own rails, orchestrator spans and orphans.
- [x] 1.3 Hidden findings [UI → /frontend-design]: `hiddenFindings` in `packages/ui/src/lib/waterfall.ts` lists, for each collapsed row, the findings with evidence among its hidden descendants, worst first, leaving out the ones that name the row itself. A collapsed row shows:
  - a `⚠ N inside` chip that opens the worst one like a deep link;
  - a hollow notch at the left edge;
  - the titles in its accessible name;
  - a "Hidden inside" list in its tooltip.

  Tests: the lib function, and a static render of the row.
- [x] 1.4 `patch` changeset for `runray`. Browser check in ink and paper on the demo's delegation-heavy run (1,439 spans, 19 subagents, 8 of them nested):
  - the rail runs under an expanded subagent's caret;
  - with all subagents collapsed (485 rows), the four findings that sit inside subagents show as `⚠ 1 inside` on their rows, with the hollow notch and the "Hidden inside" tooltip;
  - clicking one clears the `/` filter and expands that subagent: 75 more rows, matching its `+75`. Its evidence rows light up, and the Inspector opens the finding.

## 2. Review follow-ups

- [x] 2.1 Hidden findings and rails [UI → /frontend-design]:
  - `hiddenFindings` counts a finding only when all its evidence lies inside the collapsed subtree, so a session-wide finding with one call in a subagent stays off it;
  - the `⚠ N inside` chip moves next to the row's own chip, ahead of the Σ rollup, where a narrow waterfall doesn't clip it;
  - one left-edge notch shows the worse of the row's own and hidden findings;
  - the tooltip reads the findings at render, so a caret click under the pointer can't leave them stale, and re-measures only when its content changes;
  - the Inspector lists a selected collapsed row's hidden findings as buttons, which is the keyboard path to them;
  - rails drop to 35%, and siblings share one rails array.

  Tests:
  - straddling evidence and nested holders in `waterfall.test.ts`;
  - chip order and both notch cases in `waterfall-row.test.tsx`;
  - the Inspector list and its deep link in `inspector-hidden-findings.test.tsx` (jsdom);
  - the palette guard now reads every `--color-span-*` token instead of a fixed list.
- [ ] 2.2 Proposal, spec and the colour comment describe the follow-ups and stop calling the colours the search's maxima. Browser check of the chip in the default layout, with the Inspector open.
