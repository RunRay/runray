---
"runray": patch
---

The totals on a session or subagent row of the timeline (`Σ $… · N calls`) now count every call beneath the row. A call that began in the same millisecond as the turn or subagent it belongs to could be left out, so the row showed less than the session cost.

A session in which no call has a published price now shows its cost as `Unpriced` in the header. It used to read `Local / $0.00`, which is what a session on a free local model shows.

The session list shows a dot for every model a session called. A model with no published price, such as the Codex approval reviewer, had none, and a session that ran on it alone showed no model.
