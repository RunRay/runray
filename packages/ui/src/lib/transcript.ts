/**
 * Transcript fetch + cache for the Inspector pane (D4). The client only
 * ever sends run/span ids — the server resolves provenance from its own
 * trusted TraceFile; redaction refuses inside core before any file I/O.
 * Responses cache per `run:span` so browsing spans never re-reads disk.
 */

export interface TranscriptSegment {
  label: string;
  text: string;
}

export type TranscriptState =
  | { status: 'ok'; segments: TranscriptSegment[]; truncated: boolean }
  | { status: 'redacted' | 'unsupported' }
  | { status: 'unavailable'; reason: string };

const cache = new Map<string, TranscriptState>();

export async function fetchTranscript(
  runId: string,
  spanId: string,
): Promise<TranscriptState> {
  const key = `${runId}:${spanId}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  let state: TranscriptState;
  try {
    const res = await fetch(
      `/api/transcript?run=${encodeURIComponent(runId)}&span=${encodeURIComponent(spanId)}`,
    );
    state =
      res.status === 404
        ? {
            status: 'unavailable',
            reason: 'transcripts need a current runray view',
          }
        : ((await res.json()) as TranscriptState);
  } catch (err) {
    state = {
      status: 'unavailable',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  cache.set(key, state);
  return state;
}
