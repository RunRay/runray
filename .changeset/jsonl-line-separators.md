---
"runray": patch
---

Claude Code sessions no longer lose a record whose text contains the Unicode line separator (U+2028) or paragraph separator (U+2029). Such a record was read as two broken lines and dropped with two "unparseable JSONL line" warnings, which removed that call's tokens and cost or left a tool call shown as still running.
