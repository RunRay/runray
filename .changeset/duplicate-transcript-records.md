---
"runray": patch
---

Claude Code sessions that the desktop app re-appended after a bridge (every
record before the `bridge-session` marker written a second time) no longer
count every tool call twice. The adapter keeps the first copy of each record,
so tool calls, tool errors, code-change counts and the findings built on them
match the session once; token totals and cost were already counted once per
API call and are unchanged.
