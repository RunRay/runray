---
"runray": patch
---

Sessions on OpenAI Codex-family models are now priced at those models' own published rates. Before, such a model was priced as the base model its id starts with: `gpt-5.3-codex` as `gpt-5`, which was 29% too low, and `gpt-5.1-codex-mini` as `gpt-5.1`, which was five times too high. A run on `gpt-5.3-codex` therefore shows a cost 40% higher than it did.

The `-pro` and deep-research models (`gpt-5-pro`, `o3-pro`, `o3-deep-research` and the like) get their own rates the same way. The bundled price list is refreshed to 2026-11-14, and `runray pricing --refresh` now keeps these models too.

Models that have since been retired, such as `claude-opus-4-1`, `claude-sonnet-4-20250514` and `grok-4`, stay in the bundled list at their last published rates, so older sessions keep their costs.

A retired model no longer lends its rates to an unknown model whose name starts with it: `grok-4-fast` was priced as `grok-4`, about 15 times too high, and is now listed as unpriced until the price list holds it.

A price file written by `runray pricing --refresh` before an upgrade still takes the place of the bundled list. When it is older than the bundled list, RunRay now says so once, with both dates, since models the bundled list added later are priced from the older file by a similar name or not at all. Deleting the file returns you to the bundled list.

The advice to move a subagent or a session to a cheaper model no longer names a model that costs more. A cheap model of a new generation, such as `gpt-5.6-luna`, was told to move to `gpt-5.4-mini`, which costs almost four times as much; it now gets no such advice. The same check holds for the model comparison in the dashboard.

The estimate behind "Heavy fixed context" no longer adds a cache-write premium for a session that wrote nothing to the cache, which is every Codex session. For models whose cache-write rate is above their input rate that estimate was too high, by 1 to 8% on our sample sessions.

The warning about unpriced models no longer suggests `runray pricing --refresh` when the only such model is one no price list holds, like Codex's approval reviewer.
