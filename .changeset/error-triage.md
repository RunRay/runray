---
"runray": minor
---

Errors get a triage: what happened, who can act, what to do.

- A failed tool's preview now starts where the failure is named — the last
  line that says `failed`/`error`/`exception` (never a "0 errors" line),
  else the first line after the shell wrapper's `Exit code N` — so a batch
  tool's error is its failing step, not its successful log, and a shell
  error is the message, not the wrapper. The wrapper line becomes
  `tool.exitCode` in the Claude Code adapter.
- A call the person declined ("The user doesn't want to proceed…",
  OpenCode's "The user rejected permission…" or "Tool execution aborted") is
  `cancelled` with `statusReason: user-rejected`, not an error: it no longer
  counts as a tool error and no longer feeds retry-loop,
  scattered-tool-failures or dead-end-run.
- Every failure gets an error class and an owner — yours to fix, tooling,
  agent slip, model call, expected feedback — read from its text by
  `@runray/core/triage`, with a playbook per class per source. A run's
  failures group into clusters (class × tool) with the model call that
  reacted to each one, whether the tool came back, and the findings that
  cite them. docs/08 gains a generated "Errors, class by class" block.
- A new **Errors** tab beside Overview, Timeline Explorer and Time: who
  can act first, then what happened, then what to do. Failures grouped by
  owner with the error text, each occurrence a jump to the timeline, the
  findings that cite them, and the playbook for the session's own source.
  Expected feedback (a test that did not pass yet) is collapsed and dimmed.
- The errors pill in the sessions table and rail turns red only when a
  failure is yours to fix or the session never got past one; otherwise it reads
  neutral, and "· N yours to fix" says why when it is red.
- The Inspector explains a failed span: what it is, who can act, whether
  the tool came back, what the reaction cost, and what you can do.
