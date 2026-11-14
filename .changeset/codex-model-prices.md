---
"runray": patch
---

Sessions on OpenAI Codex-family models are now priced at those models' own published rates. Before, such a model was priced as the base model its id starts with: `gpt-5.3-codex` as `gpt-5`, which was 29% too low, and `gpt-5.1-codex-mini` as `gpt-5.1`, which was five times too high. A run on `gpt-5.3-codex` therefore shows a cost 40% higher than it did.

The `-pro` and deep-research models (`gpt-5-pro`, `o3-pro`, `o3-deep-research` and the like) get their own rates the same way. The bundled price list is refreshed to 2026-11-14, and `runray pricing --refresh` now keeps these models too.

Models that have since been retired, such as `claude-opus-4-1`, `claude-sonnet-4-20250514` and `grok-4`, stay in the bundled list at their last published rates, so older sessions keep their costs.

A retired model no longer lends its rates to an unknown model whose name starts with it: `grok-4-fast` was priced as `grok-4`, about 15 times too high, and is now listed as unpriced until the price list holds it.

The warning about unpriced models no longer suggests `runray pricing --refresh` when the only such model is one no price list holds, like Codex's approval reviewer.
