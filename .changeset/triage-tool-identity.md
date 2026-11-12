---
"runray": patch
---

The Errors tab groups a failed shell command by the program it ran (`pnpm run · test`, `git push`) instead of by `Bash`, and a failure counts as recovered only when that program ran again and succeeded. Before, any later shell command counted, so a failed test run followed by an `ls` read as recovered.
