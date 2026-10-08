# Tasks: validate-pricing-refresh

Definition of done: `pnpm lint && pnpm typecheck && pnpm test` green, no schema drift, goldens in `fixtures/normalized/` and the bundled pricing snapshot unchanged.

## 1. Pricing refresh

- [x] 1.1 `convertLitellmPricing` (core) leaves out a chat model of a known provider when a published rate is negative, not a finite number, or above $10,000 per million tokens, and reports it through `onInvalid`. A missing or `null` rate still falls back. `scripts/build-pricing-snapshot.ts` warns for each one. Tests in `packages/core/src/pricing/litellm.test.ts`: negative, string, absurd and infinite rates; `null` and zero kept; foreign providers and `sample_spec` never reported.
- [x] 1.2 `refreshPricing` treats the reply as untrusted, and `loadUserPricing` checks what it reads (`packages/cli/src/pricing.ts`):
  - a 60 s timeout and a 32 MiB cap (declared length first, then a streamed count);
  - an HTML page refused;
  - JSON parsed and checked as an object keyed by model (zod; moved to core in 2.1);
  - at least half the bundled snapshot's model count;
  - an atomic write through `writeFileAtomic` (`packages/cli/src/atomic-write.ts`);
  - `RefreshResult.skipped` lists the left-out models;
  - the loader checks the stored table with zod and falls back with a warning naming the field.

  Tests in `pricing.test.ts` cover each refusal and confirm that the previous file stays byte-identical with no temp file left. They also cover an endless body stopped at the cap, a reply that never comes, a left-out model, and the loader with an empty table, a negative rate and a non-numeric rate. `atomic-write.test.ts` covers a failing rename.
- [x] 1.3 `pricing --refresh` prints at most ten `warning: left out …` lines plus a count, and on failure adds "Nothing was written; runray keeps its current prices." (`pricing-command.test.ts`). `docs/05-ARCHITECTURE.md` §2.3 is updated, plus a `patch` changeset for `runray`. A real refresh into a scratch path: 236 models, none left out, about 0.3 s.

## 2. Review follow-ups

- [x] 2.1 Code follow-ups:
  - `priceListFromText` in core: JSON, an object keyed by model, conversion, and `minEntries` (at least 1) with `PriceListTooShortError`. It is used by `refreshPricing` and by `scripts/build-pricing-snapshot.ts`, which also gets a timeout and refuses a list under half the current snapshot;
  - `--allow-short-list` lets the command and the script accept a shorter list, never an empty one;
  - a chat model with no input price is skipped before any rate is checked, so it never warns;
  - the download stops after 30 s without data or 10 min in all, instead of 60 s for everything;
  - a connection failure names its `cause`.

  Tests in `litellm.test.ts` and `pricing.test.ts` include real fetch against a local server: one that stalls after the headers, one that drips under the idle limit, and a host that can't be reached. `atomic-write.test.ts` adds a write that fails part-way.
- [x] 2.2 Proposal, spec, `docs/05-ARCHITECTURE.md` §2.3 and the changeset describe the follow-ups. A real refresh into a scratch path still gives 236 models, none left out.
