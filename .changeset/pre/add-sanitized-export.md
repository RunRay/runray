---
"runray": minor
---

Two export profiles that keep the structure and drop the content:
`sanitized` pseudonymizes paths and prunes leaf spans, `metadata-only`
keeps counts and shapes alone. The dashboard reads the export's manifest
and says what was removed, and a dialog in the dashboard writes the CLI
command for the profile you pick.
