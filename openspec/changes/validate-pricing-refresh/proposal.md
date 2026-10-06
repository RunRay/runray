# Proposal: validate-pricing-refresh

## Why

`runray pricing --refresh` is the product's only network operation. It downloads LiteLLM's price list and overwrites `~/.config/runray/pricing.json`, and every later command prices runs from that file. Today it trusts the reply completely (`packages/cli/src/pricing.ts`):

- **No size or time limit.** `res.json()` reads the whole body into memory with no cap and no timeout. A hijacked or broken endpoint can stream without end or never answer.
- **No shape check.** The body is cast to `Record<string, unknown>`. A `[]` or `{}` reply becomes a table with 0 models, which the loader accepts, so every call afterwards is silently unpriced.
- **No rate check.** `convertLitellmPricing` only requires a finite number, so a negative rate becomes a negative price. A string rate silently falls back to another rate.
- **Non-atomic write.** The new table is written straight over the old file, so a failed write leaves a broken override behind.
- **Lenient loader.** It accepts any object with a `snapshotDate` string and an `entries` array: empty, negative or non-numeric rates included.

## What Changes

- **Transport** (`refreshPricing`):
  - a 60-second timeout;
  - a 32 MiB cap, about ten times today's 3 MB list: a larger `content-length` is refused without reading, and the streamed body is cut off as soon as it passes the cap;
  - an HTML page (a proxy or captive portal) is refused. Other content types are accepted, because GitHub serves the list as `text/plain`.
- **Shape:**
  - the body must parse as JSON and be an object keyed by model (zod);
  - the converted table must hold at least half as many models as the bundled snapshot, or the reply is refused as truncated.
- **Rates** (`convertLitellmPricing`, core): for chat models of the known providers, a published rate that is negative, not a finite number, or above $10,000 per million tokens leaves that model out. The model is reported through a new `onInvalid` option. A missing or `null` rate still means "not published" and falls back as before. Models outside the known providers are never checked, so LiteLLM's `sample_spec` entry stays harmless.
  - `pricing --refresh` prints a `warning: left out <model>: <reason>` line for each, at most ten, then a count.
  - The snapshot build script warns the same way.
- **Write:** atomic, through a temp file created exclusively next to the target and then renamed (`writeFileAtomic`). Any refusal or failure leaves the previous file byte-identical, and the command adds "Nothing was written; runray keeps its current prices."
- **Read:** `loadUserPricing` checks the stored table with a zod schema: at least one model, rates that are numbers ≥ 0, `source` and `aliases` present. A file that fails falls back to the bundled snapshot with the existing warning, which now names the field.

## Impact

- Affected specs: cli (ADDED "Pricing refresh accepts only a sound price list").
- Affected code:
  - `packages/core/src/pricing/litellm.ts`
  - `packages/cli/src/{pricing,atomic-write,program}.ts`
  - `scripts/build-pricing-snapshot.ts`
  - their tests
  - `docs/05-ARCHITECTURE.md` §2.3
- No schema change, no new dependency (zod is already a CLI dependency), goldens and the bundled snapshot unchanged.
- Behaviour change:
  - a refresh that used to write an empty or partial table now fails and keeps the previous prices;
  - an override that is empty or has invalid rates is ignored with a warning instead of leaving every call unpriced.
