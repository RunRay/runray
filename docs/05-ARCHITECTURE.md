# RunRay — Architektura Systemu (całe narzędzie, 0.1 → 1.0)

Dokument techniczny dla obu torów. Sekcje oznaczone wersją, w której moduł wchodzi do gry.

## 1. Widok systemu

```
                    ┌──────────────────────────── packages/cli ───────────────────────────┐
 ~/.claude/…  ─┐    │  discover ─▶ adapters ─▶ normalize ─▶ TraceFile ─▶ enrich            │
 opencode.db ─┼───▶ │  (core)      (core)      (core)       (schema)    ├─ cost-engine    │
 otlp.json  ──┘    │                                                    └─ insights       │
                    │        ┌───────────────┬──────────────────┬──────────────────┐      │
                    │        ▼               ▼                  ▼                  ▼      │
                    │   serve UI        export .html        --json stdout      ci gate    │
                    │  (node:http,     (singlefile,          (scripting)      (v1: exit   │
                    │   127.0.0.1)      inline data)                           codes)     │
                    └──────────────────────────────────────────────────────────────────────┘
                                          ▲
                              packages/ui (Vite React SPA, dist embedded in npm pkg)
```

Monorepo: pnpm workspaces · ESM only · Node ≥ 20 · biome (lint+fmt) · vitest · tsc strict. Pakiety: `schema` (zod, zero deps poza zod), `core` (zależy od schema), `cli` (core + embedded ui dist), `ui` (schema przez typy).

## 2. `packages/core`

### 2.1 SourceAdapter (interfejs wtyczkowy)
```ts
interface SourceAdapter {
  id: 'claude-code' | 'opencode' | 'otlp';
  /** Domyślne korzenie zero-config — detect() i watch czerpią z TEGO SAMEGO
   *  źródła, więc nigdy się nie rozjadą; OTLP (import-only) zwraca []. */
  defaultRoots(): string[];
  /** Tanie skanowanie znanych lokalizacji + ścieżek usera. Nie parsuje. */
  detect(roots: string[]): Promise<Candidate[]>;   // {runRef, format, files, mtime, sizeBytes}
  /** Pełny parse jednego runa do formatu pośredniego. */
  parse(c: Candidate, opts: {redact: boolean}): Promise<RawRun>;
}
```
Rejestr adapterów w `core/adapters/index.ts`; nowy agent = nowy plik, zero zmian w CLI/UI. Każdy adapter ma testy golden: `fixtures/<source>/<variant>` → `fixtures/normalized/<...>.json` (snapshot).

Szczegóły per adapter:
- **claude-code:** streaming readline po JSONL; rekonstrukcja drzewa: mapa `uuid→record`, krawędź z `parentUuid`; parowanie `tool_use.id ↔ tool_result.tool_use_id`. Subagenty w dwóch erach (jak multi-era OpenCode): **obecna** (zweryfikowana 2026-07 na CC 2.1.138–2.1.197) — tool_use `Agent` (`input: {subagent_type, description, prompt}`; mapowanie: `subagent_type` → `agent.name`, `description` → `content.delegationReason`), transkrypt dziecka w **osobnym pliku** `<session-uuid>/subagents/agent-<agentId>.jsonl` (agenty workflow: `subagents/workflows/wf_*/`), join w kolejności: (1) `toolUseResult.agentId` na wyniku DOWOLNEGO narzędzia — także forki skilli (`Skill` → `status:'forked'`, nazwa z `commandName`), nie tylko `Agent`; (2) sidecar `agent-<agentId>.meta.json` (CC ≥2.2) — agenci w tle nie zostawiają `agentId` w żadnym tool result, a sidecar niesie `toolUseId` (spawnujący tool_use), `parentAgentId` (zagnieżdżenia; adopcja iteruje do fixpointu) oraz `name`/`agentType`/`description`; transkrypty bez żadnego joinu → warning i pominięcie. **Era legacy** (`Task` + inline `isSidechain:true`): w v0.1 bez rekonstrukcji zagnieżdżenia — rekordy parsują się płasko, run dostaje warning (pełne wsparcie dopiero, gdy beta userzy zgłoszą logi sprzed 2.x). Uwaga: `isSidechain` w obecnej erze jest zawsze `false`, a `logicalParentUuid` oznacza granice kompaktowania kontekstu, nie subagenty. `detect()` musi obejmować podkatalog `subagents/` sesji (pliki `journal.jsonl` z workflowów: domyślnie pomijane, decyzja w tasku 2.2); szczegóły — Open Q1 w `02-DATA-MODEL.md`. **Duplikaty rekordów:** aplikacja desktopowa po rekordzie `bridge-session` dopisuje transkrypt od początku (te same `uuid`, `message.id` i id narzędzi, nowe linie, drobne różnice metadanych: nowszy `version`, `slug`, czasem wyzerowany `toolUseResult`) — adapter zachowuje PIERWSZE wystąpienie każdego `uuid` i pomija kolejne kopie (także powtórzony `tool_use` o znanym id lub `tool_result` dla znanego `tool_use_id`), więc każdy span powstaje raz, provenance wskazuje linię zapisaną na żywo, a sumy tokenów/kosztu/błędów odpowiadają pojedynczej kopii sesji; rekordy bez `uuid` nie są deduplikowane (spec: trace-ingestion „Duplicate transcript records").
- **opencode:** trzy formaty za jedną fasadą: (a) storage plikowy `session/message/part`, (b) `opencode.db` przez `better-sqlite3` **read-only** (`?mode=ro`, obsługa WAL; jeśli lock → czytelny błąd z instrukcją), (c) pliki z `opencode export`. Wersjonowanie: adapter deklaruje zakres wspieranych wersji OpenCode; test kontraktowy łapie dryf.
- **otlp:** import OTLP/JSON (file exporter); mapowanie `resourceSpans→spans`, atrybuty `gen_ai.*` **i `runray.*`** przenoszone 1:1 do `attributes`; nazwy spanów Claude Code beta pinowane w fixture.

Atrybuty zarezerwowane (prefiks `runray.`, add-profiler-depth): adaptery claude-code/opencode stemplują na rozpoznanych narzędziach plikowych i komendach (w Claude Code także `PowerShell`) `runray.targetKey` (16-hex podwójny FNV znormalizowanego celu — identyczny między adapterami i trybami redakcji), `runray.targetKind` (`file-read|file-write|command`) oraz `runray.target` (basename, TYLKO bez redakcji). OpenCode klasyfikuje narzędzia MCP heurystyką (allowlista wbudowanych + prefiks przed pierwszym `_` → `mcp_call` + `tool.mcpServer`), każdy trafiony span niesie `runray.mcpDetection: 'name-heuristic'`. Adapter claude-code stempluje dodatkowo na spanach `llm_call` `tracepulse.cacheWrite1hTokens` (licznik tokenów, redact-safe): udział 1-godzinnego TTL w `tokens.cacheWrite` z `usage.cache_creation.ephemeral_1h_input_tokens` (clamp do sumy) — silnik kosztów wycenia ten udział po stawce 1h zamiast 5m. OTLP przenosi klucz 1:1, ale go NIE wyprowadza, a OpenCode w ogóle nie ma rozbicia TTL w storage — na obu tych ścieżkach zapisy 1h wyceniają się po stawce 5m (asymetria względem transkryptu JSONL, udokumentowana komentarzami w obu adapterach). Spany narzędzi ze statusem `error` niosą `content.outputPreview` — 200 znaków tekstu błędu liczone od linii, która nazywa porażkę (`adapters/error-preview.ts`, wspólne dla trzech adapterów: ostatnia linia ze słowem failed/failure/failing/error(s)/exception(s) bez negacji „0 errors”, inaczej pierwsza linia nie będąca `Exit code N`, inaczej pierwsza linia; null pod `--redact`); adapter claude-code wyprowadza z linii `Exit code N` pole `tool.exitCode`. Odrzucenie wywołania przez użytkownika („The user doesn't want to proceed…”, OpenCode „The user rejected permission…”) daje status `cancelled` + `statusReason: user-rejected` zamiast `error` — nie wchodzi do `toolErrors` ani do reguł porażek. retry-loop, dead-end-run i scattered-tool-failures cytują pierwszą linię podglądu (≤ 120 znaków).

### 2.2 Normalizer
Pipeline czystych funkcji: `RawRun → buildTree → classifyKinds → deriveDepth → attachProvenance → Run`. Deterministyczny (stabilne sortowanie po `startedAt, id`) — warunek golden testów i diffa (v0.2). W przypadku uszkodzonych relacji hierarchicznych (span z `parentId` wskazującym rekord nieistniejący w runie; `parentId: null` to legalny root) normalizator stosuje Flat Trace Fallback: osierocone spany podpina pod korzeń runa z przeliczonym `depth`, zachowuje porządek chronologiczny i dopisuje warning do runa.

### 2.3 Cost engine
- Snapshot cennika (generowany z danych LiteLLM w build-time) w assetach paczki: `{modelPattern, inputPerMTok, outputPerMTok, cacheReadPerMTok, cacheWritePerMTok, cacheWrite1hPerMTok?}` + `snapshotDate`. `cacheWritePerMTok` to stawka domyślna (TTL 5 min); opcjonalne `cacheWrite1hPerMTok` (LiteLLM `cache_creation_input_token_cost_above_1hr`, tylko wartości > 0) wycenia udział 1h z `tracepulse.cacheWrite1hTokens`. Brak opublikowanej stawki 1h: dla wzorców `claude-*` silnik stosuje udokumentowaną premię Anthropic 2× input; dla pozostałych providerów (brak produktu z TTL) udział 1h liczy się po zwykłej stawce zapisu — silnik nigdy nie wymyśla premii, której provider nie pobiera.
- Dopasowanie modelu: exact → prefix → alias-tabela (np. warianty `-latest`), każde porównanie wykonywane również na kluczach ze znormalizowanym separatorem wersji (`looseModelKey`: `.` między cyframi → `-`, bo OpenCode/zen zapisuje `claude-opus-4.5` tam, gdzie LiteLLM ma `claude-opus-4-5`) — exact w dowolnej pisowni bije prefiks, luźny klucz nigdy nie wymyśla wpisu spoza tabeli; brak dopasowania ⇒ `costSource:'unknown'`, koszt pomijany w sumach, badge w UI (nigdy nie zgadujemy po cichu).
- `pricing --refresh` (opt-in, jedyna dozwolona operacja sieciowa) nadpisuje snapshot w `~/.config/runray/pricing.json`.
- Tabelaryczne testy: (model, tokens) → USD, w tym cache write/read i reasoning.
- **Silnik browser-safe** (`pricing/engine.ts`, subpath `@runray/core/pricing`): czysta matematyka (match/compute/reprice) bez snapshotu i node builtins — UI wykonuje TĘ SAMĄ implementację co insighty (test czystości grafu importów + grep bundli w CI).
- **What-if repricing** (`repriceRun`/`repriceSpans`): te same czwórki tokenów po stawkach targetu (udział 1h z `tracepulse.cacheWrite1hTokens` po stawce 1h TARGETU — dla targetów bez produktu 1h po jego zwykłej stawce zapisu); kanoniczne komórki atrybucji (main session + subagenci, innermost) z flagami ryzyka `errors|tool-fanout|long-context|unpriced` i `safeDeltaUSD` (tylko komórki bez flag). Drabinka `MODEL_TIERS` (per rodzina, wersjonowana w kodzie) + `suggestedDowngrade` rozwiązywany względem tabeli EFEKTYWNEJ z guardem zerowych stawek; skrypt snapshotu ostrzega o znikających targetach.
- **`unpricedCoverage(run)`**: statystyka uczciwości (ile llm-calli/tokenów bez ceny, posortowane modele) — liczona na żądanie, nigdy nie persystowana; zasila ostrzeżenie stderr, pola `list --json` i banery/caveaty UI.

### 2.4 Insights engine (12 reguł)
```ts
interface InsightRule { id: string; evaluate(run: Run, ctx: RuleContext): Finding[]; }
// RuleContext = { thresholds: Thresholds; pricing: PricingTable } — reguły
// wyceniają ZAWSZE z tabeli efektywnej, nigdy bez warunku ze snapshotu.
```
Reguły są czyste, konfigurowalne przez `runray.config.json` (`insights.thresholds`), testowane na syntetycznych runach. Klasyfikacja i prezentacja z JEDNEGO rejestru `insights/meta.ts` (`RULE_META`: label · explain · klasa · playbook, subpath `@runray/core/insights-meta`; pokrycie wymuszone testem; playbooki — przyczyny · akcje per źródło · ograniczenia — renderowane do bloku „How to fix, rule by rule" w 08-FINDINGS.md skryptem `pnpm docs:playbooks`, test dryfu pilnuje zgodności): klasa **waste** (spalone pieniądze) wchodzi do `totals.costUSD.wastedEstimate` z twardym capem `≤ costUSD.total`; klasa **opportunity** niesie `estimatedWasteUSD` do rankingu, ale nigdy nie zawyża rollupu. Kolejność rejestracji ZAMROŻONA (id insightów od niej zależą): piątka v0 → `model-mismatch` → szóstka nowych.

| ruleId | klasa | Logika detekcji (klucz configu, domyślne progi) | estimatedWasteUSD |
|---|---|---|---|
| `retry-loop` | waste | klaster okienkowy nieudanych wywołań o tej samej tożsamości `(name, runray.targetKey)` w jednym scope (najbliższy subagent/sesja); toleruje `maxGapToolCalls: 3` innych calli między próbami; sukces tej samej tożsamości zamyka sagę (`retryLoop.minFailures: 3`; stary klucz `minConsecutiveFailures` = deprecated alias) | rodzice klastra ∪ llm-calle TEGO SAMEGO scope w oknie pierwsza→ostatnia próba (równoległe poddrzewa nie płacą za cudzą pętlę) |
| `low-cache-hit` | opportunity | `hitRate < maxHitRate: 0.4` ∧ `total > minCostUSD: 0.10` ∧ `llmCalls ≥ 5` | `(targetHitRate: 0.6 − hitRate) × input × Δ(input−cacheRead)`; target konfigurowalny, clampowany ≥ progu odpalenia |
| `context-bloat` | opportunity | mediana kontekstu (`input+cacheRead+cacheWrite`, tylko główna sesja) ostatnich 3 calli > `multiplier: 2`× mediany pierwszych 3 ∧ > `minMedianInputTokens: 50k` | **kumulatywna** nadwyżka `Σ max(0, ctx_i − baza)`, każdy call po swojej efektywnej stawce za token input-class (cache read tam, gdzie kontekst był z cache; samo `input` nigdy nie widziało wzrostu sesji z cache); górna granica — zakłada, że praca mogła toczyć się dalej na skompaktowanym kontekście |
| `expensive-subagent` | opportunity | koszt poddrzewa > `minShareOfRunCost: 0.5` runa ∧ > `minCostUSD: 0.25` (innermost) | poddrzewo przecenione przez `suggestedDowngrade` + `repriceSpans`; brak tańszego tieru ⇒ finding bez kwoty z wyjaśnieniem |
| `dead-end-run` | waste | run kończy się błędem (span sesji lub ostatni span) | **ogon po awarii**: llm-calle po ostatnim udanym toolu ze zmianą kodu, minus roszczenia klastrów retry; 100% TYLKO gdy nic nie powstało |
| `model-mismatch` | opportunity | per model z rozwiązywalnym downgrade'em: bezpieczna oszczędność repricingu ≥ `modelMismatch.minSavingsUSD: 0.5` (flagi ryzyka: `riskToolCalls: 25`, `riskContextTokens: 150k`); poddrzewa objęte `expensive-subagent` WYKLUCZONE (zero podwójnego liczenia) | delta risk-free z `repriceRun` ograniczonego do spanów modelu |
| `cache-prefix-break` | waste | kolejna para llm tego samego modelu: `aRead ≥ minPrefixTokens: 20k` ∧ `bRead ≤ collapseRatio: 0.2 × aRead` ∧ `bWrite ≥ rewriteFloorTokens: 10k`; para spełniająca też predykat idle należy do `idle-cache-expiry`; kształt złamania z tokenów obu spanów: **kompakcja** (kontekst b < `shrinkRatio: 0.6` × kontekstu a), **front** (bRead < `baseRetainedTokens: 5k`, zmieniła się lista narzędzi, system prompt lub ustawienie), inaczej **historia** (front z cache, rozmowa zapisana ponownie); kształt steruje treścią, nie kwotą | `min(bWrite, aRead) × Δ(cacheWriteEff−cacheRead)` — premia za ponowny zapis; `cacheWriteEff` = efektywna stawka zapisu spanu b (blend 5m/1h z `tracepulse.cacheWrite1hTokens`), ta sama matematyka co `costUSD` spanu |
| `idle-cache-expiry` | waste | przerwa `≥` TTL ŻYWEGO cache'a: 60 min gdy ostatni piszący span w strumieniu scope+model (niekoniecznie para `a` — tura tylko-czytająca nie kasuje TTL) pisał z większościowym udziałem 1h, inaczej `idleCacheExpiry.minIdleMinutes: 5` (TTL 5m providera) ∧ `bWrite ≥ 10k` ∧ było co tracić | `min(bWrite, aRead+aWrite) × Δ(cacheWriteEff−cacheRead)` |
| `fixed-context-overhead` | opportunity | footprint 1. calla `input+cacheRead+cacheWrite ≥ floorTokens: 20k` ∧ `llmCalls ≥ 5` (sesja "urodzona gruba" — wzrostowy context-bloat jej nie widzi) | `nadwyżka × (cacheWriteEff + cacheRead×(n−1))` — zapis raz, odczyt przy każdym kolejnym callu |
| `duplicate-read` | waste | ten sam `runray.targetKey` (file-read) czytany ponownie bez file-write pomiędzy; ≥ `duplicateRead.minRepeats: 3` odczytów | zbędne odczyty: `outputBytes/4` tokenów (jawna heurystyka, "≈") po stawce input |
| `scattered-tool-failures` | waste | błędy poza klastrami retry ≥ `minFailures: 5` ∧ udział ≥ `minErrorShare: 0.2` | koszt UNIKALNYCH llm-calli reagujących na awarie (per scope) |
| `oversized-output` | opportunity | tool-outputy ≥ `oversizedOutput.minOutputBytes: 100k` (top `topOffenders: 5` w evidence) | `Σ bytes/4` po stawce input — użyteczność outputu niepoznawalna, NIGDY w rollupie waste |

**Severity** (`info` | `warning` | `critical`) NIE jest własnością reguły — nadaje ją silnik po wyliczeniu wszystkich findingów, wyłącznie z wielkości `estimatedWasteUSD` względem `totals.costUSD.total` runu (`insights.thresholds.severity`): `critical` gdy udział ≥ `criticalShare: 0.10` ∧ kwota ≥ `criticalFloorUSD: 1`; `warning` gdy udział ≥ `warningShare: 0.02` ∧ kwota ≥ `warningFloorUSD: 0.05`; inaczej `info`. Finding bez kwoty lub run bez wyceny (`total = 0`) ⇒ `info`. Severity odpowiada więc na pytanie „jak duże to jest w TYM runie", klasa — „czy to już stracone"; obie osie są niezależne. UI sortuje pasek findingów po kwocie malejąco, severity barwi pigułkę. Wersja dla użytkownika (klasy, tiery, tabela 12 reguł, klucze configu): [08-FINDINGS.md](08-FINDINGS.md).

### 2.5 Error triage (`triage/`, subpath `@runray/core/triage`)

Błąd wywołania to nie jedna rzecz: na realnych sesjach jedna trzecia „błędów" to pętla popraw-i-sprawdź agenta, jedna trzecia to potknięcia modelu poprawione w sekundach, a poniżej jednej dziesiątej to coś po stronie użytkownika. `classifyError(span)` czyta z tekstu porażki (`content.outputPreview`, kind, nazwa narzędzia, `tool.exitCode`) **klasę** i **właściciela** (`you` · `tooling` · `agent` · `model` · `work` · `unknown`) — uporządkowana lista regexów, pierwsze trafienie wygrywa, czysta funkcja spanu; bez tekstu (redakcja) spada do kształtu spanu (`mcp_call` → `mcp-error`, kod wyjścia ≠ 0 → `exit-nonzero`, reszta `unclassified`). `triageRun(run)` grupuje porażki w klastry klasa × narzędzie z kosztem reakcji (pierwsze wywołanie modelu w tym samym zakresie po porażce, liczone raz), powrotem narzędzia (następne wywołanie tej samej nazwy w zakresie: ok · error · brak), wynikiem klastra (`recovered` · `looping` · `unrecovered`) i id findingów, które cytują jego spany; sygnał `needsAttention` (klaster `you`, albo `unrecovered` poza `work`, po którym już nic nie zadziałało) steruje kolorem pilla z liczbą błędów. Spany `cancelled` są liczone, nigdy triażowane. Rejestr `ERROR_CLASS_META` (label · explain · owner · playbook per źródło) jest jedynym źródłem dla zakładki Errors, Inspectora i bloku „Errors, class by class" w 08-FINDINGS.md (`pnpm docs:playbooks`, test dryfu). Weryfikacja na 610 realnych porażkach użytkownika (2026-09-03): 3 nierozpoznane.

## 3. `packages/cli` — pełna specyfikacja

```
runray view   [path]  [--source claude|opencode|otlp] [--since 7d] [--port N]
                        [--watch] [--redact] [--no-open]
runray list   [path]  [--json] [--since 7d]
runray export [path|runId] -o report.html [--json out.json] [--redact] [--yes]
runray demo            # otwiera viewer na wbudowanym, zanonimizowanym fixture (zero-friction wow)
runray pricing [--show | --refresh]
runray diff   <runA> <runB> [path] [--json] [--source …] [--since 7d]  # add-run-diff
runray ci     [--budget <usd>] [--baseline <ref|plik.json>]            # v1
                [--fail-on-cost-regression <pct>] [--fail-on <ruleId,…>]
                [--report out.html] [--json]
Globalne: --config <plik>, --verbose, --version
```
Gołe `runray` = `runray view` (subkomenda domyślna; literówka w nazwie komendy trafia do `[path]` i kończy się exit 3 z podpowiedziami). Exit codes: `0` OK · `1` błąd wykonania · `2` bramka CI nie przeszła · `3` nie znaleziono danych. Config `runray.config.json` (cwd → `~/.config/runray/`): progi insightów, domyślny `--redact`, dodatkowe data-roots, port, **`limitWindow`** (opt-in okno referencyjne trybu %: `days/resetDay/resetHour/budgetUSD/budgetTokens`; niepoprawne pola odpadają z ostrzeżeniem). `list --json` raportuje dodatkowo `unpricedLlmCalls`/`unpricedTokens`; discovery wypisuje JEDNO ostrzeżenie stderr, gdy pokrycie cen < 100% (stdout `--json` zawsze czysty). `diff` rozwiązuje referencje runów jak `export` (dokładne id → unikalny prefiks; niejednoznaczne/brakujące → exit 3 z podpowiedzią `runray list`), parsuje zawsze z redakcją (diff nie dotyka treści promptów) i drukuje chipy delt tekstowo — wartość bezwzględna + procent (procent pomijany przy zerowej bazie), najgorsze regresje kosztu najpierw; **`diff --json` drukuje strukturę `RunDiff` z `@runray/core/diff` verbatim — to kontrakt wejściowy bramki CI (planowany add-ci-gate go konsumuje), odtąd rozwijany wyłącznie addytywnie** (istniejące pola nie zmieniają nazw, typów ani znaczenia).

Serwer lokalny: goły `node:http`, bind **wyłącznie 127.0.0.1**, port 4173 + inkrementacja gdy zajęty; endpointy: `GET /` (embedded dist), `GET /api/tracefile`, `GET /api/events` (SSE, tylko `--watch`), `GET /api/pricing` (tabela efektywna capture-once + provenance origin/snapshotDate), `GET /api/transcript?run=&span=` (wycinek surowego loga za provenance spanu — klient wysyła WYŁĄCZNIE id; redakcja odmawia w core PRZED I/O; brakujące pliki/nieznane id/OTLP → statusy strukturalne, nigdy crash; cap 1 MB + `truncated`), `GET /api/viewconfig` (`{limitWindow?}`, `{}` gdy brak). Watch: chokidar (polling fallback); **zero-config watchuje unię `defaultRoots()` adapterów** (z filtrem `--source`; OTLP nic nie wnosi — import-only) → event `changed` → UI refetch; capture-once cennika odświeża się dokładnie przy inwalidacji cache — ta sama ścieżka rebuildu, którą podepnie add-persistent-index.

Pakowanie UI: skrypt `prepack` w `packages/cli` buduje `ui` i kopiuje `ui/dist` + `ui/dist-export` do `cli/assets/` (pole `files` w package.json); publikowany jest wyłącznie pakiet `cli` — `ui` pozostaje `private: true`. Dzięki temu `npx runray` ściąga jeden pakiet z gotowym frontendem.

Eksport singlefile: szablon `ui/dist-export/index.html` (vite-plugin-singlefile) + wstrzyknięcie przez jeden `injectGlobal` trzech globali — `__RUNRAY_DATA__`, `__RUNRAY_PRICING__` (origin+tabela; lokalna ścieżka overridu NIGDY nie trafia do udostępnialnego pliku) i `__RUNRAY_VIEW_CONFIG__` — z sanitizacją `</script>` i `<!--`. **Guard prywatności:** eksport bez `--redact` wypisuje ostrzeżenie i wymaga `--yes` lub interaktywnego potwierdzenia (plik zawiera prompty!).

## 4. `packages/ui`

- Ładowanie danych: `window.__RUNRAY_DATA__`/`__RUNRAY_PRICING__`/`__RUNRAY_VIEW_CONFIG__` (export) → fallback `fetch('/api/...')` (serve); brak payloadu cennika ⇒ powierzchnie repricingu pokazują notę, nigdy nie fabrykują stawek. Jeden store zustand (+ slice'y `pricing`, `limit`); UI importuje runtime WYŁĄCZNIE z browser-safe subpathów `@runray/core/pricing`, `.../insights-meta`, `.../diff` i `.../triage` (X1). Zakładka **Errors** (`#/run/:id/errors`, `ErrorsView`) renderuje `triageRun` z core: podsumowanie (ile wymaga użytkownika, ile wróciło do działania, koszt reakcji), pasek właścicieli, oś czasu porażek, klastry per właściciel z tekstem błędu, wystąpieniami (skok do Timeline Explorer przez `selectSpan` + `navigateTo`), findingami (`showInsight`) i playbookiem klasy dla źródła sesji; grupa „Expected feedback" zwinięta i przygaszona. Pill z liczbą błędów (tabela sesji, lista Explorera, zakładka) bierze ton z `triageTone` (czerwony tylko gdy `needsAttention`); dopisek „· N need you" z `byOwner.you` pokazuje tylko szeroka tabela sesji, wąska lista Explorera i zakładka niosą samą liczbę, a rozbicie właścicieli siedzi w tooltipie — `lib/triage.ts` cache'uje triage per obiekt runu (WeakMap).
- Drzewo komponentów: `App → TopBar(FilterBar, LimitModeToggle, freshness "as of") / SessionsPane / Overview(SavingsPanel[EvidenceInline], KPI, SpendSection, RankCards, ToolRankCard, WasteBoard) / RunView(InsightsStrip, Waterfall[badge Σ poddrzewa], CostView(WhatIfPanel, NestedTreemap, StackedBar, WasteTable), TimeView) / Inspector(TranscriptPane)`.
- IA dashboardu (D1): SavingsPanel — uczciwy podział burned/opportunity z caveatami pokrycia — prowadzi stronę; liczniki wydatków zdegradowane niżej. Stan filtrów (6 wymiarów, w tym `tool`) jedzie w hashu (`replaceState`, bez spamu historii) — linki filtrowane są udostępnialne; `#/run/:id/time` = dekompozycja wall-clocka (sweep bez podwójnego liczenia równoległości, chip ×N).
- Waterfall: własny SVG w wierszach wirtualizowanych (`@tanstack/react-virtual`); skala czasu wspólna per run; pozycjonowanie barów czysto z `startedAt/durationMs` (memoizowane layouty per subtree).
- Diff view (add-run-diff): rekurencyjne parowanie spanów per grupę rodzeństwa po multizbiorze `(kind, name)` — k-te wystąpienie klucza paruje się z k-tym chronologicznie, więc zmiana kolejności niezależnych rodzeństw nie generuje fałszywych added/removed; UI renderuje TEN SAM `RunDiff` z `@runray/core/diff`, który drukuje CLI (tabela podsumowania = figury CLI z konstrukcji); CI report (v1): wariant print `03-design.md §4.6`.
- Routing hashowy (działa z `file://` po eksporcie). Zero zewnętrznych fontów w exporcie (subset woff2 inline).

## 5. Budżety wydajności (mierzone od tygodnia 1, fixture `large`)
| Operacja | Budżet |
|---|---|
| Parse 100 MB JSONL | < 5 s (streaming, bez wczytywania pliku do RAM) |
| `view` cold start → render | < 2 s przy 2k spanów |
| Scroll waterfall 10k spanów | 60 fps (wirtualizacja) |
| RAM procesu CLI | < 500 MB na `large` |
| Rozmiar `report.html` | < 1.5 MB + dane |
Bench: `pnpm bench` (tinybench) w CI jako informacyjny, fail dopiero przy 2× regresji.

## 6. Bezpieczeństwo i prywatność (USP, nie checklist)
Zero połączeń sieciowych w runtime (jedyny wyjątek: jawny `pricing --refresh`); bind 127.0.0.1; brak telemetrii produktu — deklarowane w README jako gwarancja; `--redact` w core (nie w UI), więc dane wrażliwe nie opuszczają parsera; SQLite otwierane read-only; ścieżki wejściowe kanonikalizowane (bez podążania za symlinkami poza root skanu); test CI: `view`/`export` pod `--offline`-owym network-guardem (mock `net` rzuca).

## 7. Testy i CI
- Unit (vitest): adaptery (golden), cost engine (tabelaryczne), reguły insightów (syntetyczne runy), scrub-fixture.
- Schema: walidacja wszystkich `fixtures/normalized/*` przeciw `runray.schema.json`; zakaz zmian schematu bez bumpa wersji (skrypt diffa schematu w CI).
- E2E (vitest, konwencja repo — Playwright wciąż planowany jako smoke): `profiler-e2e` (serwer live nad fixtures: pricing/transcript z odmową redakcji/viewconfig; round-trip eksportu z trzema globalami, bajt-deterministyczny) + `bundle-guard` (grep dist/dist-export: zero better-sqlite3, snapshotu cen i node builtins).
- GitHub Actions: `lint → typecheck → unit → schema → build → e2e (linux) → bench(info)`; release przez changesets (semver, changelog), kanały npm `latest`/`next`.

## 8. Decyzje odłożone (świadomie)
Baza danych/indeks trwały (v0.2: cache w `~/.cache/runray`), graf delegacji (v0.2), multi-user/auth (nigdy w local tool; dopiero self-hosted dashboard v1+), pluginy zewnętrzne adapterów (po stabilizacji interfejsu ~v0.3).
