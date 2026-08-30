# Design: add-local-trace-viewer

Authoritative detail lives in the top-level docs; this file records the binding technical decisions for this change.

- **Language/runtime:** TypeScript, Node ≥ 20, ESM (ADR-1, internal plan). One language across the monorepo so schema types are shared end-to-end. A Go rewrite was considered and deferred with explicit revision criteria (ADR-6); the frozen `TraceFile` contract keeps a future core/cli port cheap without touching the UI.
- **UI stack:** Vite + React 18 + Tailwind v4 + shadcn/ui; custom SVG waterfall with `@tanstack/react-virtual`; **not Next.js** — the visualizer ships as static assets embedded in the npm package (ADR-2).
- **Ingestion order:** local on-disk stores before OTLP, because OTel export requires configuration and zero-config is the product promise (ADR-3). Adapter plugin architecture with golden-fixture contract tests absorbs vendor format churn (OpenCode is mid-migration to SQLite).
- **Contract:** `TraceFile` schema v0.1 frozen end of week 1; UI develops against `fixtures/normalized/` from day one (ADR-4).
- **Export:** single self-contained HTML via vite-plugin-singlefile with injected `window.__RUNRAY_DATA__`; `</script>` sanitized; export without `--redact` requires confirmation (ADR-5 + privacy guard).
- **Cost:** bundled LiteLLM-derived pricing snapshot; unknown models are surfaced (`costSource: unknown`), never silently priced.
- **Non-goals held firm:** no database, no collector daemon, no network calls at runtime, no accounts.

Key risk & mitigation: `isSidechain` → spawning-Task linkage in Claude Code JSONL may be implicit; task 1.4 verifies against fixtures, with a time-window heuristic as fallback (documented in `docs/02-DATA-MODEL.md`, Open Questions).
