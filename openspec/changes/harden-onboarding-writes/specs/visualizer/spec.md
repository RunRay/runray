# Delta for visualizer

## ADDED Requirements

### Requirement: Cross-site requests refused by the local server
The local server SHALL refuse every request whose method is neither `GET` nor `HEAD` when the browser names another requester: a `Sec-Fetch-Site` header other than `same-origin`, or an `Origin` header other than `http://` followed by the request's `Host` (compared case-insensitively, with the default port 80 folded), SHALL be answered with 403 after the loopback `Host` guard and before any route runs. A request carrying neither header SHALL pass this check. The refused request's body SHALL NOT be read, and the connection SHALL be closed once the response is sent. `GET` and `HEAD` requests SHALL NOT be subject to this check; the server sends no CORS headers, so another origin cannot read their responses.

#### Scenario: Foreign origin refused on a route without writes
- GIVEN a running local server
- WHEN a client sends `POST /api/tracefile` with `Origin: https://evil.example`
- THEN the response status is 403

#### Scenario: Checked before the route's own method rules
- GIVEN a running local server
- WHEN a client sends `DELETE /api/onboarding` with `Origin: https://evil.example`
- THEN the response status is 403, not 405, and no state is modified

#### Scenario: Default port folded
- GIVEN a running local server reached as `localhost:80`
- WHEN the dashboard posts with `Origin: http://localhost` and `Sec-Fetch-Site: same-origin`
- THEN the request is not refused by this check

#### Scenario: Reads unaffected
- GIVEN a running local server
- WHEN a client sends `GET /api/onboarding` with `Origin: https://evil.example` and `Sec-Fetch-Site: cross-site`
- THEN the response status is 200
