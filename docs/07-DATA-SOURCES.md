# RunRay — Skąd biorą się dane (explainer)

Dokument wyjaśniający, w przystępnym języku, skąd RunRay pobiera dane, jaką rolę pełni OpenTelemetry i dlaczego dane z różnych narzędzi wyglądają na końcu tak samo. Szczegóły normatywne są w [02-DATA-MODEL.md](02-DATA-MODEL.md), [05-ARCHITECTURE.md](05-ARCHITECTURE.md) i [04-SAMPLE-LOGS.md](04-SAMPLE-LOGS.md) — tutaj chodzi o zrozumienie, nie o kontrakt.

## Zasada fundamentalna: czytamy, nie zbieramy

RunRay **nie instrumentuje** agentów i **nie uruchamia** żadnego kolektora czy demona. Czytamy logi, które narzędzia agentowe **już same zapisują na dysku** podczas normalnej pracy.

To jest sedno obietnicy "zero-config": użytkownik nie musi niczego konfigurować, ustawiać zmiennych środowiskowych ani zmieniać sposobu, w jaki uruchamia agenta. Odpala `runray view` i narzędzie samo znajduje sesje w znanych lokalizacjach. Logi leżą tam *zawsze* — także dla sesji, które odbyły się, zanim użytkownik w ogóle poznał RunRay.

Konsekwencja projektowa: **zero wywołań sieciowych w czasie działania** (jedyny wyjątek to jawny, opt-in `runray pricing --refresh`), serwer lokalny słucha wyłącznie na 127.0.0.1, żadnej własnej telemetrii.

## Trzy źródła danych (w kolejności priorytetów)

### 1. Claude Code — priorytet 1
Każda sesja to jeden plik JSONL:
`~/.claude/projects/<projekt>/<uuid-sesji>.jsonl`
(na Windows: `%USERPROFILE%\.claude\projects\...`).

Jeden rekord na wiadomość. Z każdego rekordu wyciągamy m.in.: zużycie tokenów (`usage`: input, output, cache read, cache write), powiązania budujące drzewo delegacji (`uuid` / `parentUuid`), znacznik subagenta (`isSidechain`) oraz bloki `tool_use` / `tool_result` (wywołania narzędzi i ich wyniki).

### 2. OpenCode — priorytet 2
OpenCode jest w trakcie migracji formatu, więc obsługujemy **trzy warianty za jedną fasadą**:
- **storage plikowy** (starszy, wciąż częsty) — osobne pliki JSON w katalogach `session/`, `message/`, `part/`,
- **SQLite** (`opencode.db`) — otwierany **wyłącznie do odczytu** (`read-only`), żeby nigdy nie ruszyć ani nie zablokować bazy używanej przez działający OpenCode,
- **`opencode export`** — pliki JSON z komendy eksportu (najprostszy sposób na pojedynczą sesję).

Ważny szczegół: OpenCode zapisuje `cost: 0` w swoich danych. Dlatego koszt **zawsze** liczy nasz silnik wyceny na podstawie liczby tokenów — nigdy nie ufamy kwocie ze źródła. (Pole `costSource` w schemacie zapisuje, czy liczba została podana przez źródło, czy policzona przez nas.)

### 3. OTLP (OpenTelemetry) — priorytet 3, ścieżka power-user
Import plików OTLP/JSON. To furtka dla "custom agents" i dla natywnych trace'ów Claude Code (beta). Szczegóły — patrz sekcja niżej.

## Rola OpenTelemetry — dlaczego tak, ale nie jako fundament

OpenTelemetry (OTel) to naturalny, branżowy standard obserwowalności i RunRay go **nie ignoruje**. Ale świadomie umieściliśmy go jako **trzecią ścieżkę importu, nie jako podstawę**. Dwa powody:

1. **OTel wymaga konfiguracji — a my sprzedajemy zero-config.**
   Żeby Claude Code emitował trace'y OTLP, użytkownik musi ustawić zmienne środowiskowe (`CLAUDE_CODE_ENABLE_TELEMETRY=1`, endpoint eksportu itd.) i postawić OTel Collector. To dokładnie ta bariera wejścia, którą RunRay ma likwidować. Pliki JSONL na dysku istnieją bez żadnej konfiguracji; trace'y OTel — tylko jeśli ktoś je wcześniej włączył. (To jest decyzja ADR-3: "lokalne magazyny na dysku przed OTLP".)

2. **Standard jest w naszej domenie niedojrzały.**
   Trace'y OTel z Claude Code to funkcja **beta** — nazwy spanów mogą się zmieniać, więc "pinujemy" je we fixture'ach. Konwencja atrybutów GenAI (`gen_ai.*`) ma dopiero status Development.

### Strategia: "miękka adopcja" standardu
Tam, gdzie nasz atrybut ma odpowiednik w konwencji GenAI, używamy nazwy `gen_ai.*` w worku `attributes` — czyli jesteśmy zgodni ze standardem. Ale nasz schemat **nie zależy od niego twardo**: import OTLP dostaje osobny adapter (traktowany jako *best-effort*), a nieznane kształty spanów degradują się do `kind: other` zamiast wywalać import. Dzięki temu dowolny agent, który umie emitować OTel, ma drogę do RunRay — bez wiązania rdzenia produktu z betą.

**Podsumowanie dla kolegi:** OpenTelemetry jest OK i jest w planie — ale jako opcjonalny import dla zaawansowanych, nie jako główne źródło. Fundamentem są logi z dysku, bo tylko one dają "zero-config".

### Uwaga: „OTLP" nie znaczy „jeden wspólny format"

Częste nieporozumienie: skoro dwie aplikacje emitują OTLP, to dostaniemy to samo. **Tak — ale tylko kopertę. Nie — co do treści.** To rozróżnienie jest kluczowe dla adaptera OTLP (task 2.8):

- **Koperta jest uniwersalna** (proto `trace/v1`): każdy plik OTLP/JSON, niezależnie od źródła, ma ten sam szkielet — `resourceSpans[] → resource.attributes + scopeSpans[] → spans[]` z polami `traceId` (32 hex), `spanId`/`parentSpanId` (16 hex), `name`, `kind`, `startTimeUnixNano`/`endTimeUnixNano` (int64 **jako string**), `attributes:[{key, value:{stringValue|intValue|…}}]`, `events`, `status`. To samo kodowanie idków, czasów i atrybutów u wszystkich. Dlatego strukturalna obsługa w scrubie (`scripts/scrub-fixture.ts --source otlp`) jest źródło-agnostyczna.
- **Semantyka jest per-aplikacja.** Nazwy spanów i klucze atrybutów są własne dla każdego emitera:
  - Claude Code = bespoke `claude_code.interaction`/`llm_request`/`tool`/`hook` + hybryda atrybutów (część `gen_ai.*`, reszta własna: `input_tokens`, `cache_read_tokens`, `agent_id`, `session.id`, `user_prompt`, `user.email`…),
  - inna aplikacja = własne nazwy albo konwencja GenAI (`chat {model}`, `gen_ai.operation.name`, `gen_ai.usage.input_tokens`, `gen_ai.provider.name`).

  Dwa pliki OTLP z dwóch narzędzi dzielą **pudełko, ale nie etykiety w środku**.

**Konsekwencje:**
- *Adapter 2.8* jest z założenia best-effort: mapuje to, co rozpozna (`gen_ai.*` + zapinowane w fixture nazwy `claude_code.*`), nieznane atrybuty przepuszcza 1:1 do `attributes`, a nieznane kształty spanów degraduje do `kind: other`. Pełna wierność (model, tokeny, linkowanie subagentów) wymaga wiedzy per źródło.
- *Scrub* obsługuje strukturę uniwersalnie, ale listy `OTLP_KEEP_KEYS`/`OTLP_IDENTITY_KEYS` są dostrojone pod Claude Code. Dla OTLP z innego narzędzia nieznane klucze i tak scrubują się domyślnie (privacy-first) — ale klucze strukturalne warte zachowania (np. inny licznik tokenów) oraz inne klucze tożsamości trzeba by do tych list dopisać.

**OpenCode konkretnie:** nie emituje OTLP natywnie — to wciąż [feature request (#14697)](https://github.com/anomalyco/opencode/issues/14697). OTLP dostaje się z OpenCode tylko przez społecznościowy plugin [`@devtheops/opencode-plugin-otel`](https://github.com/DEVtheOPS/opencode-plugin-otel), który „mirror-uje sygnały Claude Code" — ale to mapowanie autora pluginu, nie gwarancja identyczności z `claude_code.*`. Dlatego OpenCode czytamy **natywnie** (file-storage / SQLite / `opencode export`, adapter 2.3), nie przez OTLP — tam realnie leżą jego dane i to jest ścieżka zero-config.

## Czy format jest taki sam dla różnych narzędzi?

**Surowe formaty — zupełnie różne. Po naszej normalizacji — identyczne.** To jest wręcz główna wartość produktu.

Te same pojęcia u źródeł wyglądają zupełnie inaczej:

| Pojęcie | Claude Code | OpenCode | OTLP |
|---|---|---|---|
| Sesja (Run) | jeden plik `.jsonl` | `ses_*.json` lub wiersz w SQLite | spany o wspólnym `session.id` |
| Wywołanie LLM | wiadomość asystenta + `usage` | `message` + `parts` (ma też tokeny `reasoning`) | span `claude_code.llm_request` |
| Wywołanie narzędzia | blok `tool_use` + sparowany `tool_result` | `part` typu tool ze stanem | span `claude_code.tool` |
| Subagent | rekordy `isSidechain: true` | sesja-dziecko z `parentID` | zagnieżdżenie spanów |

### Jak to sprowadzamy do jednego formatu
Każde źródło ma swój **adapter** (implementuje `detect()` / `parse()`). Wszystkie adaptery wpadają do wspólnego **normalizera**, który produkuje jeden format — `TraceFile` zgodny z [`schema/runray.schema.json`](../schema/runray.schema.json). To jest **kontrakt**: UI widzi wyłącznie znormalizowane dane i nigdy nie czyta surowych logów.

Efekt:
- waterfall, koszty i insighty działają **identycznie** niezależnie od tego, czy sesja przyszła z Claude Code, OpenCode czy OTLP,
- dodanie nowego agenta (np. Codex, Gemini CLI — plan V3) to **tylko nowy adapter**, zero zmian w UI.

### Ważne zastrzeżenie: struktura ta sama, ale bogactwo danych — nie zawsze
Zasada "**superset-normalize**": schemat jest sumą możliwości wszystkich źródeł, a pola, których dane źródło nie dostarcza, są po prostu opcjonalne i puste. Przykłady:
- tokeny `reasoning` ma OpenCode, Claude Code niekoniecznie,
- metryki `codeChanges` (dodane/usunięte linie) policzymy tam, gdzie źródło zapisuje treść wywołań Edit/Write,
- atrybuty specyficzne dla jednego źródła lądują w worku `attributes`, zamiast ginąć.

Dodatkowo każdy span ma `provenance` (plik + linia / rekord źródłowy), więc z dowolnego miejsca w UI da się zajrzeć "pod spód", do surowego zapisu.

## W jednym zdaniu

Czytamy logi, które agenci już zapisali na dysku (Claude Code, OpenCode; OTLP opcjonalnie), tłumaczymy każdy format przez osobny adapter na jeden wspólny schemat `TraceFile` i dopiero na nim budujemy koszty oraz insighty — dzięki czemu wygląda to tak samo niezależnie od narzędzia, bez żadnej konfiguracji po stronie użytkownika.
