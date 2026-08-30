---
"runray": patch
---

Report a broken better-sqlite3 install as one clear message. The module loads
its native addon lazily inside the constructor, so a missing or ABI-mismatched
binary sailed past the load check and surfaced later as a raw `bindings` dump
naming whichever OpenCode database happened to be scanned first — with the
wrong remedy attached. The addon is now probed at load time, so every failure
mode arrives as a single actionable error and the other sources keep working.
