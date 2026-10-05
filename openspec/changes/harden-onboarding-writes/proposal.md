# Proposal: harden-onboarding-writes

## Why

`POST /api/onboarding` is the only route on the local server that changes anything. It sits behind the loopback `Host` guard, which stops DNS rebinding, but not cross-site requests. Any page open in the user's browser can send a "simple" cross-site POST (`text/plain`, no CORS preflight) to `http://127.0.0.1:4173/api/onboarding`. The browser sends that request with a loopback `Host`, and the handler parses any body as JSON, so the page can overwrite the user's onboarding state. The patch filter keeps only known keys, but `tours` and `hints` merge without a limit, so repeated requests can also grow `state.json`.

The state writer has a smaller weakness. It names its temporary file from `Date.now()` and `Math.random()`, and creates it without an exclusive flag, so an existing file or symlink at that name is followed rather than refused.

## What Changes

- **Cross-site writes are refused** (`packages/cli/src/server.ts`). `POST /api/onboarding` SHALL carry an `application/json` body; anything else is answered 415. A cross-site page can only send that content type after a CORS preflight, which this server never approves. When the browser names the requester, the request SHALL come from this same origin: a `Sec-Fetch-Site` other than `same-origin`, or an `Origin` that isn't `http://<Host>`, is answered 403. Clients that send neither header (curl, Node's fetch, tests) are unaffected. In every refusal the body is discarded unread and no state is read or written.
- **Unguessable, exclusive temp file** (`packages/cli/src/onboarding-state.ts`). The temporary file is named with `crypto.randomUUID()` and created with the `wx` flag, so an existing file or symlink at that name makes the write fail (swallowed, as any write failure) instead of being followed. A temp file left behind by a failed rename is removed. No requirement changes: the spec already asks for "a temporary file in the same directory, then rename".

## Impact

- Affected specs: onboarding-state (MODIFIED "Onboarding endpoint hardening").
- Affected code: `packages/cli/src/server.ts`, `packages/cli/src/onboarding-state.ts`, and their tests.
- The UI already sends same-origin `application/json` (`packages/ui/src/lib/load.ts`), so no UI change.
- No schema change, no golden change, no new dependency.
