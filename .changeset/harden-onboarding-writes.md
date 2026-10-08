---
"runray": patch
---

The local viewer behind `runray view` and `runray demo` now refuses cross-site requests that change state. `POST /api/onboarding` only accepts a same-origin `application/json` request, so a web page open in your browser can no longer change which tours, hints and checklist steps you've seen. If you post to it by hand, send `Content-Type: application/json`. The state file is also written through a temporary file with a random name that is created exclusively.
