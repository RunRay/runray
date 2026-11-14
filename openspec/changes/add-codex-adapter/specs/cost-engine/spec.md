# Delta for cost-engine

## ADDED Requirements

### Requirement: Codex cost is computed from tokens
Codex records no dollar amounts. Every Codex `llm_call` SHALL be priced by
the cost engine from its converted token counts, with reasoning tokens at the
output rate and cached input at the cache-read rate, and marked
`costSource: "computed"`. A Codex model the effective pricing table does not
resolve SHALL stay `costSource: "unknown"` and count toward the unpriced
coverage warning; it SHALL NOT be priced as another model through an alias
added for that purpose.

#### Scenario: Priced call
- GIVEN a Codex call with input 2,000, cacheRead 8,000, output 200 and
  reasoning 300 on a model the table prices
- WHEN the run is priced
- THEN the cost is 2,000 at the input rate, 8,000 at the cache-read rate and
  500 at the output rate, and `costSource` is `computed`

#### Scenario: Reviewer model
- GIVEN a run whose reviewer subagent used `codex-auto-review`
- WHEN the run is priced and reported
- THEN those calls have no `costUSD`, their tokens are in the run totals, and
  the coverage warning names `codex-auto-review`

### Requirement: Codex-family models are priced under their own ids
The bundled pricing table SHALL hold Codex-family models under their own
ids, so a Codex model is priced at its published rates and not at those of
the base model its id starts with. A model id with no published price SHALL
be named on a documented list, with the reason.

#### Scenario: Bundled snapshot resolves current Codex models
- GIVEN the bundled pricing snapshot shipped with this change
- WHEN the model ids found in the committed Codex fixtures are matched
- THEN every id resolves to an entry whose pattern is that id, or is on the
  documented list of ids with no published price, which holds
  `codex-auto-review`

#### Scenario: A Codex variant is not priced as its base model
- GIVEN a price list that publishes `gpt-5.1` as a chat model and
  `gpt-5.1-codex-mini` as a responses model at a fifth of its rates
- WHEN the pricing table is built from it and a `gpt-5.1-codex-mini` call is
  priced
- THEN the call is priced at the `gpt-5.1-codex-mini` rates

#### Scenario: A refreshed table keeps Codex ids
- GIVEN `runray pricing --refresh` against a price list with responses-mode
  entries
- WHEN the refreshed table is used
- THEN those ids resolve to their own entries, as they do in the bundled
  table

### Requirement: Suggestions and playbooks address Codex
Wherever a suggestion or a rule playbook picks its lever by source, a Codex
run SHALL get Codex levers: `AGENTS.md` as the instructions file, and
commands and settings that exist in Codex. A Codex run SHALL NOT receive
advice that names a Claude Code or OpenCode command, file or setting, nor the
generic custom-agent wording.

#### Scenario: Instructions file
- GIVEN a finding on a Codex run whose suggestion names where standing
  instructions live
- WHEN the suggestion is rendered
- THEN it names `AGENTS.md`

#### Scenario: No foreign levers
- GIVEN every rule firing on a Codex run in the suggestion tests
- WHEN the suggestions are rendered
- THEN none contains `CLAUDE.md`, `promptCacheTtl`, `opencode` or "your
  agent's"

#### Scenario: Playbooks have a Codex section
- GIVEN the generated rule playbooks
- WHEN they are rendered
- THEN every rule has a section for Codex

### Requirement: Cache-write rules are silent on Codex runs
Codex records no cache writes. Rules whose trigger requires re-written cache
tokens (`cache-prefix-break`, `idle-cache-expiry`) SHALL produce no finding
on a run whose calls carry zero cache-write tokens. Rules that estimate a
cost from cache writes SHALL produce a finite, non-negative estimate on such
a run.

#### Scenario: Idle gap without a write
- GIVEN a Codex run with a 30-minute gap after which cached input drops to
  zero and cache-write tokens stay zero
- WHEN rules are evaluated
- THEN neither `idle-cache-expiry` nor `cache-prefix-break` fires

#### Scenario: Low hit rate still reported
- GIVEN a Codex run above the cost and call-count floors whose hit rate is
  below the threshold
- WHEN rules are evaluated
- THEN `low-cache-hit` fires with a Codex suggestion

#### Scenario: Overhead estimate without cache writes
- GIVEN a Codex run that trips `fixed-context-overhead` and whose calls all
  carry zero cache-write tokens
- WHEN the finding is produced
- THEN `estimatedWasteUSD` is a finite number of zero or more
