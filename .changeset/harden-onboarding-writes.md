---
"runray": patch
---

`runray view` now refuses cross-site writes to its onboarding state. `POST /api/onboarding` only accepts a same-origin `application/json` request, so a web page open in your browser can no longer change which tours, hints and checklist steps you've seen. The state file is also written through a temporary file with a random name that is created exclusively.
