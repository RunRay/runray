# Tasks: validate-pricing-refresh

Definition of done: `pnpm lint && pnpm typecheck && pnpm test` green, no schema drift, goldens in `fixtures/normalized/` and the bundled pricing snapshot unchanged.

## 1. Pricing refresh

- [x] 1.1 `convertLitellmPricing` (core) leaves out a chat model of a known provider when a published rate is negative, not a finite number, or above $10,000 per million tokens, and reports it through `onInvalid`. A missing or `null` rate still falls back. `scripts/build-pricing-snapshot.ts` warns for each one. Tests in `packages/core/src/pricing/litellm.test.ts`: negative, string, absurd and infinite rates; `null` and zero kept; foreign providers and `sample_spec` never reported.
- [x] 1.2 `refreshPricing` treats the reply as untrusted, and `loadUserPricing` checks what it reads (`packages/cli/src/pricing.ts`):
  - a 60 s timeout and a 32 MiB cap (declared length first, then a streamed count);
  - an HTML page refused;
  - JSON parsed and checked as an object keyed by model (zod);
  - at least half the bundled snapshot's model count;
  - an atomic write through `writeFileAtomic` (`packages/cli/src/atomic-write.ts`);
  - `RefreshResult.skipped` lists the left-out models;
  - the loader checks the stored table with zod and falls back with a warning naming the field.

  Tests in `pricing.test.ts` cover each refusal and confirm that the previous file stays byte-identical with no temp file left. They also cover an endless body stopped at the cap, a reply that never comes, a left-out model, and the loader with an empty table, a negative rate and a non-numeric rate. `atomic-write.test.ts` covers a failing rename.
- [x] 1.3 `pricing --refresh` prints at most ten `warning: left out …` lines plus a count, and on failure adds "Nothing was written; runray keeps its current prices." (`pricing-command.test.ts`). `docs/05-ARCHITECTURE.md` §2.3 is updated, plus a `patch` changeset for `runray`. A real refresh into a scratch path: 236 models, none left out, about 0.3 s.
