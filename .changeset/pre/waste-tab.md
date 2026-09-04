---
"runray": minor
---

A **Waste** tab per session: what bought nothing, and what one change would have kept.

- `@runray/core/waste` (browser-safe): a run's findings grouped by rule
  and split by class, burned (the engine's capped waste-class total) apart
  from opportunities (upper bounds, never added to it). Each group is graded
  on its sum by the engine's own severity tiers, groups whose findings are
  all under five cents fold into one line, a cache break's shape and tokens
  are read from its two evidence calls, and every burned finding is placed
  on the session's clock next to the context size of each model call.
  `gradeSeverity` and the break shape move to pure modules shared with the
  rule engine.
- The tab (`#/run/:id/waste`): the two figures, one sentence naming the
  largest burn and the lever for your tool, the leak rail (context curve,
  a bar per burn sized by amount, idle gaps, compactions, a ~200k guide;
  a bar opens the finding on the timeline), then the groups with their
  occurrences, shape split and playbook. The tab bar carries the burned
  amount.
- The Overview keeps where the money went: totals, tool leaderboard,
  cost by model, agent subtrees. Its waste table and the what-if
  repricing panel move to the Waste tab. The findings strip shows the
  five largest findings and "+N more in Waste".
- The Growing context row opens to how its estimate is counted (the
  baseline, the calls counted, the excess tokens and the rate, an upper
  bound against the session's opening context) and to what keeping the
  context under 100k, 200k or 400k tokens would have saved, by the same
  formula (`contextCapEstimates` in `@runray/core/waste`).
