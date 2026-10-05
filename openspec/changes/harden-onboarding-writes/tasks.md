# Tasks: harden-onboarding-writes

Definition of done: `pnpm lint && pnpm typecheck && pnpm test` green, no schema drift, goldens in `fixtures/normalized/` byte-identical.

## 1. Onboarding writes

- [x] 1.1 Refuse cross-site `POST /api/onboarding` in `packages/cli/src/server.ts`: 415 unless the media type is `application/json`, 403 when `Sec-Fetch-Site` is not `same-origin` or `Origin` is not `http://<Host>`; discard the body unread. Tests in `packages/cli/src/server.test.ts` for each refusal (no state file created) and for the same-origin request the UI sends.
- [x] 1.2 Name the state writer's temporary file with `crypto.randomUUID()`, create it with the `wx` flag, and remove it when the rename fails, in `packages/cli/src/onboarding-state.ts`. Tests in `packages/cli/src/onboarding-state.test.ts`.
- [ ] 1.3 Add a `patch` changeset for `runray`.
