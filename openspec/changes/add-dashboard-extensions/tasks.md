# Tasks: add-dashboard-extensions

All Track **B** (experience; `packages/ui` only). Every task: `pnpm lint &&
pnpm typecheck && pnpm test` green, goldens untouched. UI tasks run under the
`/frontend-design` skill per CLAUDE.md.

## 1. Filter foundation
- [x] 1.1 B Filter model: store slice (project · source · period) + pure
      `filterRuns()` in `lib/` with period anchoring to the newest run (D1,
      D2); unit tests incl. the export-determinism anchor — `lib/filter-runs.ts`
      (`RunFilter`, `filterRuns`, `projectKey`, `periodAnchorDay`/`periodStartDay`
      on the same `localDay` bucketing the chart uses), store slice
      `filter` + `setFilter`/`clearFilter` + `selectVisibleRuns` (active run
      stays route-resolved — an open run never vanishes under a filter)
- [x] 1.2 B Top-bar filter dropdowns + active-filter chips wired to the store;
      overview, sessions table, and sessions rail consume the filtered runs
      [UI → /frontend-design] — `FilterBar` (listbox dropdowns, brass active
      chip + dedicated ✕, Reset), `useVisibleRuns` memoized selector, `NoMatchScreen`
      when filters hide everything; options derive from ALL runs (a filter never
      hides its own alternatives); open run stays route-resolved. Adversarial
      review (correctness/a11y/stylebook) fixed 2: Tab out of an open dropdown
      refocuses the trigger instead of orphaning focus on <body>;
      `reconcileFilter` self-heals a filter whose project/source rolls off a
      --watch refresh. Browser-verified: filter narrows all three views,
      keyboard nav (arrows/Escape/Tab), NoMatchScreen, period anchoring

## 2. Overview extensions
- [x] 2.1 B New aggregates in `lib/overview.ts`: cache (hit-rate, cacheRead
      tokens), error rate, avg/median session cost, per-source totals, trend
      vs previous equal-length period with baseline suppression (D3, D8);
      unit tests each — `cacheAggregate` (token-weighted, mirrors core's
      cacheRead/(cacheRead+input)), `errorRate`, `sessionCostStats`
      (median resists a runaway), `topSources` in overview.ts; `spendTrend`
      lives in filter-runs.ts (period-window logic, avoids an overview↔filter
      import cycle) — contiguous non-overlapping windows anchored on the newest
      of all runs, project/source scoping both windows, null when periodDays
      is null / previous <2 runs / previous spent 0. +14 unit tests
- [x] 2.2 B KPI row (cache dial, error rate, avg session) + trend chip on the
      statement; spend-by-source panel [UI → /frontend-design] — shared
      `CacheDial` (extracted from CostView, geometry preserved), KPI cards,
      `TrendChip` (ember ▲ up / sage ▼ down, suppressed when null), source
      panel shown only when >1 source; allRuns+filter threaded for the trend.
      Adversarial review fixed 1: trend direction now carries an sr-only word
      (never color-alone, §6). Browser-verified: KPIs (cache 99.8%, err 2.4%,
      avg $45.65 / median $0.41 — median resists the runaway), source panel,
      trend suppression across period changes; CacheDial byte-identical in
      CostView (18px r=7) and KPI (22px scaled)
- [x] 2.3 B Overview drill-down: day bars and rank rows apply filters;
      clickable affordance + hint copy [UI → /frontend-design] — RunFilter
      gained `model` + `day` dims (filterRuns/reconcileFilter/spendTrend all
      extended; day-pin suppresses the trend); SpendByDay bars and RankList
      rows (projects/models/sources) are now filter buttons with brass active
      state + hint copy; project/source sync their dropdowns, model/day surface
      as removable `FilterChip`s. Adversarial review confirmed the filter logic
      is correct and surfaced a pre-existing duplicate-run-id assumption (the
      cross-era OpenCode goldens share one id) — fixed defensively with
      `dedupeRunIds` at the load boundary (`~n` suffix, URL-safe), so find-by-id
      opens the right run, the rail marks exactly one row current, and all runs
      are reachable. +17 unit tests. Browser-verified all four drill dimensions
      + the dedup (clicking each duplicate opens its own run). Root-cause of the
      golden collision flagged separately (task_4989b163)
- [x] 2.4 B Waste leaderboard grouped by `ruleId` (D4): group totals,
      expand/collapse, worst-group-first; existing finding rows nest inside
      [UI → /frontend-design] — `wasteByRule` (verbatim ruleId, count vs
      distinct sessionCount, summed totalUSD, worstSeverity via SEVERITY_RANK,
      groups by total desc; supersedes the removed flat `wasteLeaderboard`);
      `WasteBoard` is now a collapsible accordion, worst group open by default,
      evidence links still stage the insight + route to the timeline. +3 unit
      tests. Adversarial review: 0 confirmed (1 refuted — open-set persisting
      across filter changes is intended). Browser-verified group summary,
      collapse/expand, and evidence navigation

## 3. Palette & theme
- [x] 3.1 B Command palette (⌘K/Ctrl-K, internal — no new dependency, D7):
      run search, view switch, theme toggle, filter actions; focus trap +
      keyboard-only pass [UI → /frontend-design] — `CommandPalette` on the
      WAI-ARIA combobox+listbox pattern (focus pinned in the input,
      `aria-activedescendant` tracks the highlight; options are role=option
      buttons); `lib/fuzzy.ts` greedy subsequence matcher + `fuzzyRank`
      (stable, +8 unit tests); minimal `lib/theme.ts` runtime (flips
      `data-theme`; persistence/no-flash/export deferred to 3.2). ⌘K is
      handled ahead of the typing-target guard (a modifier chord isn't
      typing — opens from anywhere; plain-key shortcuts stay guarded). Tab/
      Shift+Tab trapped + repurposed to navigate; Home/End left for caret
      editing. Adversarial review (correctness/a11y/stylebook, 3 confirmed of
      9): fixed the `End`-on-empty-list `active=-1` write (removed Home/End
      list-jump + clamped `activeIndex ≥ 0`), added an sr-only
      `role=status`/`aria-live` region for live-filter + empty-state
      announcement, and kept `aria-controls` valid by always rendering the
      listbox. Browser-verified: open/close + focus restore, fuzzy title
      search → Enter opens the timeline, grouped vs ranked lists, arrow/Home/
      End/Tab-trap nav, theme toggle (paper `#f2ede2`), source-filter apply
      (top-bar chip + "4 of 9 runs"), empty-state live announcement
- [x] 3.2 B Theme toggle (D5): data-theme stamp, localStorage persistence,
      no-flash boot script in both the served shell and the export template;
      paper-theme QA pass across all views (contrast floor per 03-design §6)
      [UI → /frontend-design] — `theme.ts` gains `setTheme`/persist under
      `THEME_STORAGE_KEY` + `typeof document` guards (store imports it under the
      Node test env); a no-flash inline `<script>` in `index.html` stamps the
      persisted choice before paint and, being the single vite entry, inlines
      into both `dist/` (served) and `dist-export/` (export template) — verified
      present in both. Store owns a reactive `theme` slice (`setTheme`/
      `toggleTheme`); a 28px TopBar icon toggle (sun/moon) and the palette theme
      action both route through it, staying in sync. D5: no `prefers-color-
      scheme` — ink is the default. +4 theme unit tests (stubbed globals, no new
      dep). Paper QA drove two §6 contrast fixes: money brass `#8f6e1e→#816315`
      (cost text now ≥4.5:1 on every paper ground) and tertiary
      `text-faint #988d77→#8b8065` (now ~3:1 like the ink sibling); 03-design
      colour table updated. Adversarial review (3 confirmed of 6): toggle is now
      a real `aria-pressed` toggle button (SR announces the switch); icon
      `<title>` no longer shadows the button tooltip (`pointer-events-none`);
      paper text-faint raised to floor. Browser-verified: toggle + persist +
      no-flash reload, palette/TopBar sync, paper across overview/timeline/cost/
      inspector, live contrast numbers

## 4. Verification
- [x] 4.1 B E2E: filters + drill-down in the live viewer and in an exported
      file (offline); a11y pass on new controls (dropdowns, chips, palette,
      groups); update `03-design.md` §3/§4.1 checkboxes from "specced" to
      "shipped"
