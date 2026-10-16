---
"runray": patch
---

`runray pricing --refresh` now checks the downloaded price list before it replaces your prices.

- It gives up after 30 seconds without data, 10 minutes in all, or 32 MiB, and says why a connection failed (DNS, refused, TLS) instead of just "fetch failed".
- It refuses an HTML page, an empty list, or one with under half the usual models. If LiteLLM really dropped models, `--allow-short-list` accepts a shorter list.
- It leaves out any model with a negative or absurd rate and prints `warning: left out <model>: <reason>`.
- The new prices are written in one step. If anything fails, your previous prices stay exactly as they were and the command says nothing was written.

A `pricing.json` that is empty or has invalid rates is now ignored with a warning, instead of leaving every call unpriced.
