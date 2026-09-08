# Delta for onboarding-state

## MODIFIED Requirements

### Requirement: Durable per-user onboarding state
The system SHALL persist onboarding progress markers in `~/.config/runray/state.json` (honouring `$XDG_CONFIG_HOME` and Windows `%APPDATA%`). The schema SHALL preserve all existing properties (`welcomeDismissedAt`, `tours`, `hints`, timestamps) and SHALL support persisting checklist milestones (`checklist?: Record<string, boolean>`). The state file SHALL be created with `0600` permissions on POSIX, written atomically via temporary file and rename, and unknown top-level keys SHALL be preserved across writes.

#### Scenario: Checklist progress persists across sessions
- GIVEN an active onboarding session
- WHEN a checklist milestone is marked complete
- THEN the updated checklist block is persisted in `state.json` and survives server restarts

### Requirement: Onboarding HTTP API
The local server's `/api/onboarding` endpoint SHALL accept shallow-merged patches including the `checklist` object. Method filtering SHALL enforce `GET` and `POST` only (405 for other methods), payload size SHALL be capped at 4 KB, and write failures SHALL degrade gracefully by updating in-memory state without crashing.

#### Scenario: Patching checklist state
- GIVEN a running local server
- WHEN a client sends `POST /api/onboarding` with `{ checklist: { timeViewed: true } }`
- THEN the server returns 200 with the merged state document
