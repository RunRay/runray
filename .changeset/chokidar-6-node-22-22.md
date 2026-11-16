---
"runray": minor
---

runray now needs Node.js 22.22 or newer, up from 22.0. The file watcher behind `runray view` moves to chokidar 6, which requires that version. On Windows and macOS it now watches session folders with one native recursive watcher instead of one per directory.
