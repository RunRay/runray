---
"runray": minor
---

runray now needs Node.js 22 or newer; Node 20 reached end of life in April 2026. The optional SQLite reader behind OpenCode sessions moves to better-sqlite3 13, which ships its native binary for every platform inside the package, so installing runray no longer downloads that binary from GitHub. The trade-off is a larger install: about 27 MB unpacked for better-sqlite3, up from about 10 MB.
