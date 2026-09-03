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
  OpenCode's "The user rejected permission…") is `cancelled` with
  `statusReason: user-rejected`, not an error: it no longer counts as a tool
  error and no longer feeds retry-loop, scattered-tool-failures or
  dead-end-run.
