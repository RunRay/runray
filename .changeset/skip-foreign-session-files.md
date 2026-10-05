---
"runray": patch
---

A file in a scanned folder that isn't a session no longer shows up as a session dated 1 January 1970 with no calls and $0. This covers another tool's `.jsonl` next to your Claude Code projects, and an OpenCode-looking JSON file without a session id or start time. RunRay now skips such a file and prints `warning: skipped <file>: <reason>`, and every other session loads as before.
