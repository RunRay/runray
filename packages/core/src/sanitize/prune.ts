import type { Insight, Run, Span, TraceFile } from '@runray/schema';

const CONTAINER_KINDS = new Set(['session', 'subagent']);

/**
 * Prune a run to metadata-only (D5, trace-sanitization spec):
 * - Keep `session` and `subagent` spans.
 * - Drop `llm_call`, `tool_call`, `mcp_call`, `hook` spans.
 * - Re-anchor surviving container `span.parentId` to nearest surviving ancestor.
 * - Re-anchor every `Insight.spanIds` entry to nearest surviving ancestor and dedupe;
 *   empty array when no ancestor survives.
 * - `run.totals` byte-identical to unpruned run.
 * - Observably pure (input run is unchanged).
 */
export function pruneToMetadata(run: Run): Run {
  const originalSpanById = new Map<string, Span>(
    run.spans.map((s) => [s.id, s]),
  );
  const survivingSpans = run.spans.filter((s) => CONTAINER_KINDS.has(s.kind));
  const survivingIds = new Set<string>(survivingSpans.map((s) => s.id));

  function findNearestSurvivingAncestorId(spanId: string): string | null {
    let currentId: string | null = spanId;
    while (currentId !== null) {
      if (survivingIds.has(currentId)) {
        return currentId;
      }
      const span = originalSpanById.get(currentId);
      if (!span || span.parentId === null) {
        return null;
      }
      currentId = span.parentId;
    }
    return null;
  }

  const newSpans: Span[] = survivingSpans.map((span) => {
    let newParentId: string | null = null;
    if (span.parentId !== null) {
      newParentId = findNearestSurvivingAncestorId(span.parentId);
    }
    return {
      ...span,
      parentId: newParentId,
    };
  });

  const newInsights: Insight[] = run.insights.map((insight) => {
    const survivingEvidenceIds = Array.from(
      new Set(
        insight.spanIds
          .map((id) => findNearestSurvivingAncestorId(id))
          .filter((id): id is string => id !== null),
      ),
    );
    return {
      ...insight,
      spanIds: survivingEvidenceIds,
    };
  });

  return {
    ...run,
    spans: newSpans,
    insights: newInsights,
  };
}

export function pruneTraceFileToMetadata(traceFile: TraceFile): TraceFile {
  return {
    ...traceFile,
    runs: traceFile.runs.map((r) => pruneToMetadata(r)),
  };
}
