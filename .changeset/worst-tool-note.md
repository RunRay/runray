---
"runray": patch
---

The dashboard's tool-errors note names the program that failed most, such as `worst: pnpm failed 23×`, instead of the shell it ran in (`worst: Bash failed 41×`). Sessions recorded before shell commands were classified still count under the tool name.
