# Proposal: harden-onboarding-writes

## Why

`POST /api/onboarding` is the only route on the local server that changes anything. It sits behind the loopback `Host` guard, which stops DNS rebinding, but not cross-site requests. Any page open in the user's browser can send a "simple" cross-site POST (`text/plain`, no CORS preflight) to `http://127.0.0.1:4173/api/onboarding`. The browser sends that request with a loopback `Host`, and the handler parses any body as JSON, so the page can overwrite the user's onboarding state. The patch filter keeps only known keys, but `tours` and `hints` merge without a limit, so repeated requests can also grow `state.json`.

The state writer has a smaller weakness. It names its temporary file from `Date.now()` and `Math.random()`, and creates it without an exclusive flag, so an existing file or symlink at that name is written through rather than refused.

## What Changes

- **Cross-site requests are refused server-wide** (`packages/cli/src/server.ts`). Right after the `Host` guard and before any route runs, a request with a method other than `GET`/`HEAD` gets 403 when `Sec-Fetch-Site` is not `same-origin` or `Origin` is not `http://<Host>` (case-insensitive, default port 80 folded). One check covers every route, so a future write route can't forget it. Reads stay unaffected: the server sends no CORS headers, so another origin can't read their responses anyway.
- **Onboarding writes must be JSON.** `POST /api/onboarding` with a media type other than `application/json` gets 415. A cross-site page can only send that content type after a CORS preflight, which this server never approves. Clients that send neither `Origin` nor `Sec-Fetch-Site` (curl, Node's fetch, tests) are judged on the media type alone: `curl -d` without `-H 'Content-Type: application/json'` now gets 415.
- **Refusals close the connection.** A refused request's body is never read, and the response carries `connection: close`. Without it, Node drains the unread body to keep the connection alive, so a page could make the server read an upload of any size it is refusing anyway.
- **Unguessable, exclusive temp file** (`packages/cli/src/onboarding-state.ts`). The temporary file is named with `crypto.randomUUID()` and opened with `wx` (`O_CREAT | O_EXCL`), so an existing file or symlink at that name makes the write fail (swallowed, as any write failure) instead of being written through. A temp file this call opened is removed if the write or the rename fails; one it didn't open is left alone. No requirement changes: the spec already asks for "a temporary file in the same directory, then rename".

## Impact

- Affected specs: onboarding-state (MODIFIED "Onboarding endpoint hardening"), visualizer (ADDED "Cross-site requests refused by the local server").
- Affected code: `packages/cli/src/server.ts`, `packages/cli/src/onboarding-state.ts`, and their tests. `docs/11-ONBOARDING-PLAN.md` §8.2 lists the new rules.
- The UI already sends same-origin `application/json` (`packages/ui/src/lib/load.ts`), so no UI change. `runray view` and `runray demo` share the server, so both get the change.
- No schema change, no golden change, no new dependency.
- Archive after `add-onboarding-experience` and `add-sanitized-export`, whose requirements these deltas build on.
