# Tasks: harden-onboarding-writes

Definition of done: `pnpm lint && pnpm typecheck && pnpm test` green, no schema drift, goldens in `fixtures/normalized/` byte-identical.

## 1. Onboarding writes

- [x] 1.1 Refuse cross-site requests in `packages/cli/src/server.ts`: after the `Host` guard, 403 for any method other than `GET`/`HEAD` when `Sec-Fetch-Site` is not `same-origin` or `Origin` is not `http://<Host>` (default port folded); 415 for `POST /api/onboarding` unless the media type is `application/json`. Refusals send `connection: close` and never read the body. Tests in `packages/cli/src/server.test.ts` for each refusal (no state file created), for a route without writes, for the order against the 405 method check, for port 80, for an upload that keeps coming after the refusal, and for the same-origin request the UI sends.
- [x] 1.2 Name the state writer's temporary file with `crypto.randomUUID()`, open it with `wx`, and remove it when the write or the rename fails, in `packages/cli/src/onboarding-state.ts`. Tests in `packages/cli/src/onboarding-state.test.ts`.
- [x] 1.3 Add a `patch` changeset for `runray`, and list the new rules in `docs/11-ONBOARDING-PLAN.md` §8.2.
