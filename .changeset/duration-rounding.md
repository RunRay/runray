---
"runray": patch
---

A duration no longer reads `1m 60s`, `60s` or `1000ms` when its smaller unit rounds up. It now rolls over to `2m 0s`, `1m 0s` and `1.0s`.
