# Delta for onboarding-state

## MODIFIED Requirements

### Requirement: Onboarding endpoint hardening
`/api/onboarding` SHALL accept only `GET` and `POST` and SHALL answer any other method with 405. Request bodies SHALL be capped at 4 KB, with the connection destroyed once the cap is exceeded. Only known keys with known value shapes SHALL be applied; unrecognised keys SHALL be dropped silently rather than rejected. No response SHALL include a filesystem path. A write failure SHALL return 200 with the in-memory merged state rather than an error status.

A `POST` whose media type is not `application/json` SHALL be answered with 415 before its body is read or any state is written. A cross-site `POST` never reaches this endpoint: the local server answers it with 403 first (visualizer, "Cross-site requests refused by the local server"). A request carrying neither `Sec-Fetch-Site` nor `Origin` SHALL be judged on its media type alone. A refused request's body SHALL NOT be read: the connection SHALL be closed once the response is sent.

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

#### Scenario: Simple cross-site POST refused
- GIVEN a running local server
- WHEN a client posts a patch with `Content-Type: text/plain`, or with no content type
- THEN the response status is 415 and no state file is created or modified

#### Scenario: Foreign origin refused
- GIVEN a running local server
- WHEN a client posts a JSON patch with an `Origin` of another site, of another local port, or `null`
- THEN the response status is 403 and no state is modified

#### Scenario: Cross-site fetch metadata refused
- GIVEN a running local server
- WHEN a client posts a JSON patch with `Sec-Fetch-Site` set to `cross-site`, `same-site` or `none`
- THEN the response status is 403 and no state is modified

#### Scenario: Same-origin UI write accepted
- GIVEN a running local server on `127.0.0.1:<port>`
- WHEN the dashboard posts a JSON patch with `Origin: http://127.0.0.1:<port>` and `Sec-Fetch-Site: same-origin`
- THEN the response is 200 carrying the merged state

#### Scenario: Refused upload not drained
- GIVEN a running local server
- WHEN a client posts a large `text/plain` body and keeps sending after the 415
- THEN the server closes the connection instead of reading the rest of the body
