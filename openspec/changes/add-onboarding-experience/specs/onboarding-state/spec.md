# Delta for onboarding-state

## ADDED Requirements

### Requirement: Durable per-user onboarding state
The system SHALL persist onboarding state in a per-user file at `~/.config/runray/state.json`, honouring `$XDG_CONFIG_HOME` where set and using `%APPDATA%\runray\` on Windows. The file SHALL be created lazily on first write with mode `0600`, SHALL be written atomically (temporary file in the same directory followed by rename), and SHALL preserve unknown top-level keys across writes. State SHALL NOT be stored in browser `localStorage` for the welcome dialog or either tour, because the local server's port is not stable and origin-scoped browser storage does not survive a port change.

#### Scenario: State survives a port change
- GIVEN a completed dashboard tour recorded while the server listened on port 4173
- WHEN the dashboard is next served on port 4174 because 4173 is occupied
- THEN the tour is not offered again

#### Scenario: Atomic write
- GIVEN an existing state file
- WHEN a state write is interrupted
- THEN the file on disk is either the previous complete state or the new complete state, never a truncated document

#### Scenario: Unknown keys preserved
- GIVEN a state file containing a top-level key this version does not recognise
- WHEN any onboarding value is written
- THEN the unrecognised key and its value are still present in the file afterwards

#### Scenario: Restrictive permissions
- GIVEN no existing state file on a POSIX system
- WHEN the file is created
- THEN its mode is `0600`

### Requirement: Onboarding state never blocks the product
A malformed, unreadable, or absent state file SHALL be treated as empty state and SHALL NOT produce an error, a warning that implies a broken install, or a non-zero exit code. A failed write SHALL be swallowed after the value is applied in memory. No onboarding state condition SHALL prevent `view`, `list`, `export`, `diff`, `demo`, or `pricing` from completing normally.

#### Scenario: Corrupt state file
- GIVEN a `state.json` containing invalid JSON
- WHEN `runray view` runs on a machine with discovered runs
- THEN the dashboard is served normally and the process exits 0

#### Scenario: Read-only configuration directory
- GIVEN a configuration directory the current user cannot write to
- WHEN onboarding state is updated
- THEN the update is reflected for the remainder of the process and no error is surfaced to the user

#### Scenario: Absent state file
- GIVEN no state file exists
- WHEN onboarding state is read
- THEN empty state is returned and no file is created by the read

### Requirement: Onboarding state carries no sensitive data
The state file SHALL contain only onboarding progress markers: a schema version, first-seen and demo-seen timestamps, shown CLI hint keys, a welcome-dismissed timestamp, per-tour status values, and dismissed hint keys. It SHALL NOT contain filesystem paths, project names, run identifiers, model names, prompt text, or output text.

#### Scenario: No paths recorded after a custom-path scan
- GIVEN the user supplies a custom folder through the no-data wizard
- WHEN onboarding state is subsequently written
- THEN the state file contains no filesystem path

### Requirement: Onboarding state HTTP surface
The local server SHALL expose `GET /api/onboarding`, returning the current onboarding block and an empty object when no state exists, and `POST /api/onboarding`, which SHALL shallow-merge a supplied JSON patch into the stored onboarding block and return the merged block. Both SHALL be served only under the existing loopback host guard and SHALL send `cache-control: no-store`.

#### Scenario: Reading absent state
- GIVEN no state file exists
- WHEN a client issues `GET /api/onboarding`
- THEN the response is 200 with an empty onboarding object

#### Scenario: Patch merge
- GIVEN stored state where the dashboard tour is completed
- WHEN a client posts a patch marking the run tour skipped
- THEN the response contains both the completed dashboard tour and the skipped run tour

#### Scenario: Non-loopback host rejected
- GIVEN a request carrying a non-loopback `Host` header
- WHEN it targets `/api/onboarding`
- THEN it is rejected with 403 before any state is read or written

### Requirement: Onboarding endpoint hardening
`/api/onboarding` SHALL accept only `GET` and `POST` and SHALL answer any other method with 405. Request bodies SHALL be capped at 4 KB, with the connection destroyed once the cap is exceeded. Only known keys with known value shapes SHALL be applied; unrecognised keys SHALL be dropped silently rather than rejected. No response SHALL include a filesystem path. A write failure SHALL return 200 with the in-memory merged state rather than an error status.

#### Scenario: Disallowed method
- GIVEN a running local server
- WHEN a client issues `DELETE /api/onboarding`
- THEN the response status is 405 and no state is modified

#### Scenario: Oversized body
- GIVEN a running local server
- WHEN a client posts a body larger than 4 KB
- THEN the request is not applied and the connection is destroyed

#### Scenario: Unknown key dropped
- GIVEN a patch containing both a known key and an unrecognised key
- WHEN it is posted
- THEN the known key is applied, the unrecognised key is absent from the returned block, and the response status is 200

#### Scenario: Write failure degrades to success
- GIVEN a configuration directory that cannot be written
- WHEN a valid patch is posted
- THEN the response is 200 carrying the merged state

### Requirement: No onboarding state surface in exported reports
An exported report SHALL contain no reference to the onboarding endpoint and SHALL NOT attempt to read or write onboarding state. The string `/api/onboarding` SHALL NOT appear in `dist-export/index.html`.

#### Scenario: Export contains no endpoint reference
- GIVEN a built export template
- WHEN its contents are inspected
- THEN the string `/api/onboarding` is absent

#### Scenario: Export issues no onboarding request
- GIVEN an exported report opened from `file://`
- WHEN it finishes loading
- THEN no request to an onboarding endpoint is attempted
