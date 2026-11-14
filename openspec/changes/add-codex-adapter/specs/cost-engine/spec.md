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
  documented list of ids with no published price
  (`MODELS_WITHOUT_PUBLISHED_PRICE` in core), which holds
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

### Requirement: A refreshed snapshot keeps retired models
A model that the upstream price list no longer holds SHALL stay in the
bundled pricing table at the rates the list last published for it, and SHALL
be named on the snapshot's list of retired models. A model the list still
holds SHALL take its rates from the list. The size a downloaded price list
is compared with, to refuse a truncated one, SHALL be the number of models
the list itself held when the snapshot was built, without the retired ones.

A retired entry SHALL price its own id only, in either spelling of the
version separator. It SHALL NOT price another id by prefix: an id the list
never held under that name stays unpriced.

#### Scenario: Model dropped from the list
- GIVEN a bundled snapshot that prices `claude-opus-4-1` and an upstream
  list that no longer holds it
- WHEN the snapshot is rebuilt from that list
- THEN `claude-opus-4-1` resolves to an entry of its own id at its earlier
  rates, and is named among the retired models

#### Scenario: Retired dated id next to its current family id
- GIVEN a snapshot that prices `mistral-large-2402` at 4 / 12 and an
  upstream list that holds only `mistral-large` at 0.5 / 1.5
- WHEN the snapshot is rebuilt and a `mistral-large-2402` call is priced
- THEN the call is priced at 4 / 12, not at the rates of `mistral-large`

#### Scenario: Retired models do not raise the truncation bar
- GIVEN a bundled snapshot of 363 entries of which 76 are retired
- WHEN `runray pricing --refresh` downloads a list of 150 usable models
- THEN the list is accepted, because 150 is over half of the 287 the list
  held at the snapshot

#### Scenario: Unknown id that starts with a retired one
- GIVEN a snapshot whose retired models include `grok-4` at 3 / 15, and no
  entry for `grok-4-fast`
- WHEN a `grok-4-fast` call is priced
- THEN it has no `costUSD` and `costSource` is `unknown`

### Requirement: A one-word pattern prices numbered variants only
A pricing pattern that is one bare word SHALL match an id by prefix only
when the character after the boundary is a digit. A pattern of several
words keeps the prefix rule as it is.

#### Scenario: Alias that is one word
- GIVEN a table with the pattern `chat`, which the price list's
  `chat-latest` converts to
- WHEN `chat-latest`, `chat-bison-001` and `codestral-2601` against a
  `codestral` pattern are matched
- THEN the first and the third resolve to their pattern and the second is
  unpriced

### Requirement: The unpriced warning does not advise a refresh that cannot help
A model on the documented list of ids with no published price SHALL be
named as such in the unpriced-coverage warning. When every unpriced model of
a build is on that list, the warning SHALL NOT suggest
`runray pricing --refresh`.

#### Scenario: Only the reviewer is unpriced
- GIVEN runs whose only unpriced calls are on `codex-auto-review`
- WHEN the coverage warning is printed
- THEN it names `codex-auto-review (no published price)`, says a refresh
  changes nothing, and does not mention `pricing --refresh`

#### Scenario: A model a newer list might hold
- GIVEN runs with unpriced calls on `codex-auto-review` and on a model the
  snapshot does not know
- WHEN the coverage warning is printed
- THEN it suggests `runray pricing --refresh`

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

#### Scenario: The approval reviewer as the expensive subagent
- GIVEN a Codex run on which `expensive-subagent` fires for the approval
  reviewer's subagent, `guardian`
- WHEN the finding is produced
- THEN the suggestion names `approvals_reviewer`, does not tell the person
  to give the reviewer a cheaper model, and the finding carries no
  `estimatedWasteUSD`

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
