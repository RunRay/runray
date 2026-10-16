---
"runray": patch
---

A file in a scanned folder that isn't a session no longer shows up as a session dated 1 January 1970 with no calls and $0. That covers another tool's `.jsonl` next to your Claude Code projects, an OpenCode-looking JSON file without a session id or start time, and any run with no usable start time. RunRay skips such a file, prints `warning: skipped <file>: <reason>`, and loads every other session as before. A Claude Code session that has just started and has no prompt yet is skipped without a warning. An OpenCode subagent session without timestamps now starts with the call that spawned it instead of pulling the whole run back to 1970.
