# Proposal: add-codex-adapter

## Why

RunRay reads Claude Code and OpenCode sessions natively and everything else
through OTLP. Codex is the third agent people ask about, it writes complete
session logs to disk with no setup, and `docs/01-FEATURES.md` has carried it
as a V3 adapter since planning. Nothing reads those logs today.

The format was surveyed on 250 rollout files from one Windows machine (Codex
Desktop and the VS Code extension, CLI versions 0.47 to 0.162; 121,445
records; record types, keys and counters only, no prompt text). The survey found that the data fits
the existing schema, and four things a naive port of the Claude Code adapter
would get wrong:

- **Token counters use OpenAI semantics.** `input_tokens` includes the cached
  tokens and `output_tokens` includes the reasoning tokens. Copied as they
  are, cached input would be billed twice and the cache hit-rate would read
  low. The arithmetic held in all 13,535 usage records.
- **The model calls one tool, `exec`.** Current Codex runs in "code mode": the
  model writes a script, and what the script did (8,407 commands, 2,058 file
  changes, 2,011 MCP calls) is logged as separate harness records. A span per
  model call would show a session as "exec: 20 min".
- **Commands carry their shell.** A command is an argv such as
  `pwsh.exe -Command <script>`. Hashing the first token, as the target
  identity does for other sources, would give all 8,232 PowerShell-wrapped
  commands one identity and trip `retry-loop` on every long session.
- **Most files are not sessions a person started.** 183 of the 250 files are
  threads of the automatic approval reviewer ("guardian"), each pointing at
  the thread it reviewed. Listed as runs they would bury the real ones;
  dropped, their tokens would go uncounted.

Two more facts shape the change. Older rollouts are zstd-compressed
(`.jsonl.zst`; all 250 on the surveyed machine), and the frozen schema has no
`codex` value for `source.tool`.

## What Changes

- **A `codex` source adapter** in `packages/core`, registered after OpenCode
  and before OTLP. It discovers rollouts under `$CODEX_HOME/sessions`
  (default `~/.codex/sessions`), reads plain and zstd-compressed files as a
  stream, and never opens Codex's SQLite files, which are indexes derived
  from the rollouts.
- **The schema gains two enum values and moves to 0.2.0**: `codex` in
  `source.tool` and `codex-jsonl` in `source.format`. Nothing else in the
  contract changes. A 0.1.0 TraceFile is still a valid 0.2.0 document apart
  from its version string.
- **One `llm_call` span per API response**, from the per-response usage
  record, with the token counters converted to RunRay's disjoint quad. Older
  rollouts that only carry the running token event are read from that, with
  repeated events skipped.
- **`turn` spans.** Codex records turns explicitly, with a duration and the
  reason a turn stopped. A turn the person interrupted is `cancelled`; a turn
  that ended on an API error is `error` with the error code as the reason.
- **Tool spans come from what the harness did.** A command, a file change and
  an MCP call each become a span with their own duration and outcome. The
  model-level `exec` call becomes a span only when it left no such record.
- **Commands are unwrapped before identity capture.** The shell wrapper is
  taken off the argv, and the script inside goes through the existing target
  identity and tool-usage classification, in the dialect the wrapper names.
- **Child threads nest under their parent.** A rollout that names a parent
  thread becomes a `subagent` span in the parent's run (`subagent:guardian`
  for the approval reviewer) and is not listed as a run of its own.
- **Claude Code discovery skips Codex rollouts**, the way it already skips
  OTLP files, so a folder passed on the command line is not read twice.
- **CLI**: `--source codex`, the Codex root in discovery reports and
  zero-config watch, a Codex entry in the setup guides, and transcript slices
  for Codex spans.
- **Insights**: source-specific suggestions and rule playbooks gain Codex
  levers. No rule's logic changes.
- **Pricing**: the bundled snapshot is refreshed, and the price-list
  converter stops dropping entries the upstream list files under the
  `responses` mode, which is where every Codex-family model is. A Codex
  model then resolves to its own price and not, by prefix, to another
  model's: today `gpt-5.1-codex-mini` prices five times too high and
  `gpt-5.3-codex` 29% too low. The same applies to `runray pricing
  --refresh`. The reviewer model has no published price and stays unpriced.
- **UI**: Codex gets a source colour, a label, and the per-source hints the
  Waste tab and the cost note already give the other two.
- **Fixture tooling**: `scripts/scrub-fixture.ts` learns the Codex shapes,
  including two the default scrub would mishandle (file paths used as object
  keys, and diff markers that line counts depend on).

Out of scope: session titles (Codex keeps them in a separate index file, not
in the rollout); cloud threads, whose transcripts are not on disk; a cache
rule built for OpenAI's write-free caching (the two cache-lifecycle rules key
on cache writes and stay silent on Codex runs); rate-limit snapshots as input
to the limit-window mode; a span for context compaction; multi-file target
identity for one patch; a Codex story in `runray demo`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `trace-ingestion`: a Codex adapter with its discovery, compressed-file
  reading, span mapping, token conversion, tool attribution, command
  unwrapping, child-thread nesting and redaction rules; `codex` as a named
  source in the contract; Claude Code discovery skips rollout files.
- `cost-engine`: Codex cost is always computed; suggestions and playbooks
  address Codex; cache-write rules are stated as silent on Codex runs.
- `cli`: `--source codex`, Codex in root reporting, watch, setup guides and
  the transcript slice endpoint.
- `visualizer`: Codex is presented as a named source wherever sources are
  told apart.

No `trace-sanitization` delta: the profiles, the attribute allowlist and the
redaction parity invariant already apply to any adapter, and this change adds
no attribute key. No `tool-usage` delta: the registry already names the Codex
harness tools it needs to, and the additions are table rows.

## Impact

**Depends on `add-tool-usage-breakdown`** (RunRay/runray#79). The adapter
calls its shell classification and stamps its attributes; this change is
stacked on that branch until it merges.

**`packages/schema`**: two enum values, `SCHEMA_VERSION` 0.2.0, regenerated
`schema/runray.schema.json`. No runtime reader validates the version string
today, so no compatibility code is needed. Tests that pin `'0.1.0'` move.

**`packages/core`**: new `adapters/codex.ts` and a shared rollout line reader
(not `node:readline`, which splits records at U+2028, design T3);
rows for Codex in `adapters/target.ts`, `adapters/usage.ts` and
`tools/registry.ts`; a rollout check in `adapters/claude-code.ts`; a Codex
branch in `transcript.ts`, `sanitize/sanitize.ts`, `insights/rules.ts` and
`insights/meta.ts`; the entry filter in `pricing/litellm.ts` and a refreshed
`pricing/snapshot.ts`.

**`packages/cli`**: source alias and help text, setup guide copy.

**`packages/ui`**: `lib/model-colors.ts`, `lib/waste.ts`,
`components/PricingProvenance.tsx`, `components/WelcomeDialog.tsx`,
`components/CoverageNotices.tsx`, `lib/coverage.ts`, `lib/sources.ts`
(`lib/tool-table.ts` was reviewed and needed no change). Every UI task is
`[UI → /frontend-design]` per CLAUDE.md.

**Dependencies**: none added. Decompression uses `node:zlib`, whose zstd
support needs Node 22.15 or later; the package declares `>=22`. On an older
22.x a compressed rollout is skipped with one message naming the version,
and plain rollouts load.

**Fixtures and goldens**: new `fixtures/codex/<variant>` from scrubbed real
rollouts and their goldens in the three profiles. Existing goldens hold a
single run each and no version string, so the schema bump leaves them
byte-identical. The pricing step moves some of them: the four OpenCode
fixtures and the two OpenCode demo runs use `gpt-5.3-codex`, whose cost
rises by 40% once it has its own entry, and the Claude Code fixture
`duplicate-records` uses `claude-fable-5-1`, which the refreshed list prices
under its own id with a lower cache-read rate. They are regenerated in that
step's dedicated commit, and the demo runs are rebuilt.

**Docs**: `01-FEATURES`, `02-DATA-MODEL`, `04-SAMPLE-LOGS`, `05-ARCHITECTURE`,
`07-DATA-SOURCES`, `08-FINDINGS` (generated playbooks), `12-ONBOARDING-COPY`,
the README and a changeset.

## Decisions taken at sign-off

Signed off by the maintainer on 2026-11-14.

1. The schema moves to 0.2.0 with the two enum values and nothing else
   (design D1).
2. Approval-reviewer threads nest under the thread they reviewed as
   `subagent:guardian`; a child thread with no turns is dropped without a
   warning (design D2).
3. Codex turns become `turn` spans (design D3).
4. Tool spans are the harness's records of what ran; the `exec` wrapper is a
   span only when it left none (design D4).
5. zstd through `node:zlib` with feature detection, no new dependency
   (design D5).
6. The pricing snapshot is refreshed in this change; a model with no
   published price is listed as unpriced, never aliased (design D6).
7. The price-list converter keeps `responses`-mode entries, so Codex-family
   models are priced under their own ids (design D6; signed off after the
   review pass, same day).
