import type { Run, Span } from '@runray/schema';
import {
  buildScopeIndex,
  chronological,
  endMs,
  startMs,
} from '../insights/helpers.js';
import { classifyError } from './classify.js';
import {
  ERROR_CLASS_META,
  ERROR_OWNER_ORDER,
  type ErrorClassId,
  type ErrorOwner,
} from './meta.js';

/**
 * Run-level error triage (error-triage capability): every failed call of a
 * run, classified, grouped into clusters (one class × one tool), with what
 * each failure cost in reaction and whether the tool came back. A pure
 * function of the run, deterministic in every ordering, so the UI and any
 * future CLI command render the same triage.
 *
 * Reaction cost: the first model call in the same scope that starts at or
 * after the failure ends, claimed once (two failures answered by one call
 * bill it once). Recovery: the next call of the same tool in the same scope
 * — ok, another failure, or none at all. Cancelled spans (a declined call)
 * are counted but never triaged: they are the person's decision.
 *
 * A failed turn is a failed model call when no model call beneath it failed:
 * Codex records a refused or broken request on the turn, with a code in
 * `statusReason`, and its calls stay `ok`. It is triaged as a model call
 * (cluster kind `llm_call`, named by the model the thread was running on),
 * so a usage limit shows where the person looks for it. A turn above a
 * failed call is left out: that failure is counted already.
 */

export type RecoveryKind = 'ok' | 'error' | 'none';

export interface ErrorOccurrence {
  spanId: string;
  startedAt: string;
  durationMs: number | undefined;
  /** The failure text as the span carries it: string, null (redacted) or absent. */
  preview: string | null | undefined;
  /** Cost of the model call that reacted to this failure (0 when none or unpriced). */
  reactionUSD: number;
  /** What the next call of the same tool in the same scope did; `nextSpanId`
   * names it so a streak can tell "the next call failed" from "the next
   * failure of this class". */
  recovery: { kind: RecoveryKind; afterMs?: number; nextSpanId?: string };
}

export type ClusterOutcome = 'recovered' | 'looping' | 'unrecovered';

export interface ErrorCluster {
  /** `${classId}|${tool}` — stable across reloads. */
  key: string;
  classId: ErrorClassId;
  owner: ErrorOwner;
  label: string;
  /** Tool name, or the model for model-call failures. */
  tool: string;
  kind: Span['kind'];
  mcpServer: string | undefined;
  occurrences: ErrorOccurrence[];
  count: number;
  firstAt: string;
  lastAt: string;
  reactionUSD: number;
  /** recovered = the last occurrence's tool came back ok; looping = ≥3 in a
   * row or evidence of a retry-loop finding; unrecovered = the last
   * occurrence was followed by another failure or by nothing. */
  outcome: ClusterOutcome;
  /** Findings whose evidence includes an occurrence (e.g. retry-loop). */
  insightIds: string[];
}

export interface RunTriage {
  clusters: ErrorCluster[];
  /** Failed tool/MCP calls (same count as `totals.counts.toolErrors`). */
  toolErrors: number;
  /** Failed model calls — not part of the tool-error count. */
  modelErrors: number;
  /** Calls the person declined; listed for the summary, never triaged. */
  cancelled: number;
  byOwner: Record<ErrorOwner, number>;
  reactionUSD: number;
  /** Occurrences whose tool came back ok on its next call. */
  recovered: number;
  /** Something is for the person: an owner-`you` cluster, or a cluster
   * outside `work` whose tool never came back and after whose last failure
   * no tool call succeeded (the session never got past it). */
  needsAttention: boolean;
  /** Some failure carried no text (redacted or absent), so its class is a
   * fallback. */
  redacted: boolean;
}

const LOOP_RUN = 3;

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function isFailedCall(s: Span): boolean {
  return (
    s.status === 'error' &&
    (s.kind === 'tool_call' || s.kind === 'mcp_call' || s.kind === 'llm_call')
  );
}

/** Failed turns that stand for a failed model call: none of the model calls
 * beneath them failed, so nothing else reports the failure. */
function failedTurnsAsModelCalls(run: Run): Set<string> {
  const byId = new Map(run.spans.map((s) => [s.id, s]));
  const covered = new Set<string>();
  for (const s of run.spans) {
    if (s.kind !== 'llm_call' || s.status !== 'error') continue;
    let cur = s.parentId;
    while (cur !== null) {
      covered.add(cur);
      cur = byId.get(cur)?.parentId ?? null;
    }
  }
  const out = new Set<string>();
  for (const s of run.spans) {
    if (s.kind === 'turn' && s.status === 'error' && !covered.has(s.id))
      out.add(s.id);
  }
  return out;
}

export function triageRun(run: Run): RunTriage {
  const scopeOf = buildScopeIndex(run);
  const spans = chronological(run.spans);
  const failedTurns = failedTurnsAsModelCalls(run);
  const llmsByScope = new Map<string, Span[]>();
  const sameKindByScope = new Map<string, Span[]>();
  let cancelled = 0;
  for (const s of spans) {
    // "calls you declined": a tool or MCP call. A hook the harness
    // cancelled on a timeout is not one of them, and neither is a turn the
    // person interrupted (Codex records that on the turn): stopping the
    // agent declines no call
    if (
      s.status === 'cancelled' &&
      (s.kind === 'tool_call' || s.kind === 'mcp_call')
    )
      cancelled++;
    const scope = scopeOf.get(s.id) ?? s.id;
    if (s.kind === 'llm_call') {
      const list = llmsByScope.get(scope) ?? [];
      list.push(s);
      llmsByScope.set(scope, list);
    }
    if (
      s.kind === 'tool_call' ||
      s.kind === 'mcp_call' ||
      s.kind === 'llm_call'
    ) {
      const k = `${scope}|${s.kind === 'llm_call' ? 'llm' : s.name}`;
      const list = sameKindByScope.get(k) ?? [];
      list.push(s);
      sameKindByScope.set(k, list);
    }
  }
  const insightsBySpan = new Map<string, string[]>();
  for (const i of run.insights) {
    for (const id of i.spanIds) {
      const list = insightsBySpan.get(id) ?? [];
      list.push(i.id);
      insightsBySpan.set(id, list);
    }
  }

  const claimed = new Set<string>();
  const clusters = new Map<string, ErrorCluster>();
  let toolErrors = 0;
  let modelErrors = 0;
  let recovered = 0;
  let reactionTotal = 0;
  let redacted = false;

  for (const s of spans) {
    const turn = failedTurns.has(s.id);
    if (!turn && !isFailedCall(s)) continue;
    const modelCall = turn || s.kind === 'llm_call';
    if (modelCall) modelErrors++;
    else toolErrors++;
    // a turn carries no text; its code is what the harness said about it
    const text = s.content?.outputPreview;
    const preview =
      turn && typeof text !== 'string' ? (s.statusReason ?? text) : text;
    if (typeof preview !== 'string' || preview.trim() === '') redacted = true;

    const scope = scopeOf.get(s.id) ?? s.id;
    const { classId, owner } = classifyError(s);

    // reaction: first unclaimed same-scope model call at/after the end
    const after = endMs(s);
    let reactionUSD = 0;
    const llms = llmsByScope.get(scope) ?? [];
    for (const l of llms) {
      if (l.id === s.id || startMs(l) < after || claimed.has(l.id)) continue;
      claimed.add(l.id);
      reactionUSD = l.llm?.costUSD ?? 0;
      break;
    }
    reactionTotal += reactionUSD;

    // recovery: the next call of the same tool (or the next model call).
    // After a failed turn that is the first model call of the thread that
    // starts once the turn is over
    const peers =
      sameKindByScope.get(`${scope}|${modelCall ? 'llm' : s.name}`) ?? [];
    const idx = peers.indexOf(s);
    const next = turn
      ? peers.find((p) => startMs(p) >= after)
      : idx >= 0
        ? peers[idx + 1]
        : undefined;
    const recovery: ErrorOccurrence['recovery'] =
      next === undefined
        ? { kind: 'none' }
        : {
            kind: next.status === 'error' ? 'error' : 'ok',
            afterMs: Math.max(0, startMs(next) - startMs(s)),
            nextSpanId: next.id,
          };
    if (recovery.kind === 'ok') recovered++;

    // a turn is named by the model its thread was running on: the last
    // model call that started before the turn was over, or else the next
    let tool = s.name;
    if (s.kind === 'llm_call') tool = s.llm?.model ?? s.name;
    else if (turn) {
      const before = peers.filter((p) => startMs(p) < after);
      tool = (before[before.length - 1] ?? next)?.llm?.model ?? s.name;
    }
    const key = `${classId}|${tool}`;
    const occurrence: ErrorOccurrence = {
      spanId: s.id,
      startedAt: s.startedAt,
      durationMs: s.durationMs,
      preview,
      reactionUSD: round6(reactionUSD),
      recovery,
    };
    const cluster = clusters.get(key);
    if (cluster === undefined) {
      clusters.set(key, {
        key,
        classId,
        owner,
        label: ERROR_CLASS_META[classId].label,
        tool,
        kind: turn ? 'llm_call' : s.kind,
        mcpServer: s.tool?.mcpServer,
        occurrences: [occurrence],
        count: 1,
        firstAt: s.startedAt,
        lastAt: s.startedAt,
        reactionUSD: round6(reactionUSD),
        outcome: 'recovered',
        insightIds: [...(insightsBySpan.get(s.id) ?? [])],
      });
    } else {
      cluster.occurrences.push(occurrence);
      cluster.count++;
      cluster.lastAt = s.startedAt;
      cluster.reactionUSD = round6(cluster.reactionUSD + reactionUSD);
      for (const id of insightsBySpan.get(s.id) ?? []) {
        if (!cluster.insightIds.includes(id)) cluster.insightIds.push(id);
      }
    }
  }

  const byOwner: Record<ErrorOwner, number> = {
    you: 0,
    tooling: 0,
    agent: 0,
    model: 0,
    work: 0,
    unknown: 0,
  };
  const list = [...clusters.values()];
  for (const c of list) {
    byOwner[c.owner] += c.count;
    const last = c.occurrences[c.occurrences.length - 1];
    // longest run of consecutive failures among this cluster's occurrences:
    // the previous occurrence's next same-tool call must be THIS occurrence,
    // so a failure of another class in between breaks the streak
    let streak = 1;
    let longest = 1;
    for (let i = 1; i < c.occurrences.length; i++) {
      const prev = c.occurrences[i - 1];
      const cur = c.occurrences[i];
      streak =
        prev?.recovery.kind === 'error' &&
        prev.recovery.nextSpanId === cur?.spanId
          ? streak + 1
          : 1;
      longest = Math.max(longest, streak);
    }
    const looping =
      longest >= LOOP_RUN ||
      c.insightIds.some((id) =>
        run.insights.some((i) => i.id === id && i.ruleId === 'retry-loop'),
      );
    c.outcome =
      last?.recovery.kind === 'ok'
        ? looping
          ? 'looping'
          : 'recovered'
        : 'unrecovered';
    c.insightIds.sort();
  }
  list.sort(
    (a, b) =>
      ERROR_OWNER_ORDER.indexOf(a.owner) - ERROR_OWNER_ORDER.indexOf(b.owner) ||
      (a.firstAt < b.firstAt ? -1 : a.firstAt > b.firstAt ? 1 : 0) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );

  // an unrecovered cluster alarms only when the session never got past it:
  // no tool call of any kind succeeded after its last failure. A tool the
  // agent abandoned for a workaround mid-session is not the person's problem.
  let lastOkTool = Number.NEGATIVE_INFINITY;
  for (const s of spans) {
    if ((s.kind === 'tool_call' || s.kind === 'mcp_call') && s.status === 'ok')
      lastOkTool = Math.max(lastOkTool, startMs(s));
  }
  const needsAttention = list.some(
    (c) =>
      c.owner === 'you' ||
      (c.outcome === 'unrecovered' &&
        c.owner !== 'work' &&
        Date.parse(c.lastAt) > lastOkTool),
  );

  return {
    clusters: list,
    toolErrors,
    modelErrors,
    cancelled,
    byOwner,
    reactionUSD: round6(reactionTotal),
    recovered,
    needsAttention,
    redacted,
  };
}

export type TriageTone = 'alarm' | 'quiet' | 'none';

/** How the errors pill should read: red only when something is for the
 * person or a tool never came back; neutral when the agent handled it. */
export function triageTone(
  triage: Pick<RunTriage, 'toolErrors' | 'modelErrors' | 'needsAttention'>,
): TriageTone {
  if (triage.toolErrors + triage.modelErrors === 0) return 'none';
  return triage.needsAttention ? 'alarm' : 'quiet';
}
