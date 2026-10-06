---
"runray": patch
---

In the timeline, a subagent's work no longer blends into the main agent's.

- Subagent bars have their own colour: chartreuse in the dark theme and umber in the light one. Before, they nearly matched the model-call bars in dark and the tool bars in light. The new colours stay distinct for colour-blind viewers too.
- Every row inside a subagent carries a thin rail under that subagent's arrow, so nested subagents read as stacked rails.
- A collapsed row shows the findings it hides: `⚠ 2 inside`, coloured by the worst one. Hover lists them. Clicking opens the worst one and expands the subtree onto it. Collapsing subagents no longer makes their findings disappear.
