---
"runray": minor
---

Findings now tell the person running the agent what to do, and show them how.

- Every rule's suggestion addresses the person, never the model: it names a
  lever they have (a command, a config key, an instructions file, a model
  switch), carries the finding's own numbers where they change the decision,
  and picks the lever by source — Claude Code, OpenCode, or a custom agent.
- Each rule has a playbook (why it happens, what you can do in each tool, what
  is out of your hands). The Inspector shows it under *How to fix* for the
  session's own source; the findings guide carries the full set, generated
  from the same registry and checked for drift.
- Failed tool calls keep the first 200 characters of their error text (never
  under `--redact`), so retry loops, dead ends and scattered failures say what
  went wrong instead of only how often. `PowerShell` is recognized as a shell
  tool for retry identity.
- `context-bloat` measures the full context of the main session instead of the
  uncached slice, so cached sessions that grow are no longer invisible; the
  excess is priced at what each call actually paid per token and stated as an
  upper bound. `cache-prefix-break` says what survived the break — the front
  of the prompt, the history, or a compaction — and words the finding
  accordingly (`cachePrefixBreak.baseRetainedTokens`, `shrinkRatio`).
- The dashboard's savings groups describe the rule, not one finding's
  sentence.
