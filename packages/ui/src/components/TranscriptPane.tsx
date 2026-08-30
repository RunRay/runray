import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef, useState } from 'react';
import { fetchTranscript, type TranscriptState } from '../lib/transcript';
import { useAppStore } from '../store';

/**
 * Inspector transcript section (D4): the full source-log content behind a
 * span's 200-char preview. Lazy — a click loads, never an auto-fetch
 * (reading disk on every span hop would fight the browse flow); segments
 * render read-only and virtualized. Distinct states: redacted (core
 * refused before I/O), unavailable (rotated/missing source), unsupported
 * (otlp), truncated (1 MB cap), and not-live (exports point back at
 * `runray view`).
 */
export function TranscriptPane({
  runId,
  spanId,
}: {
  runId: string;
  spanId: string;
}) {
  const data = useAppStore((s) => s.data);
  const live = data.status === 'ready' && data.live;
  const [state, setState] = useState<TranscriptState | 'idle' | 'loading'>(
    'idle',
  );
  // a new span resets the pane to its lazy state
  const lastKey = useRef('');
  const key = `${runId}:${spanId}`;
  if (lastKey.current !== key) {
    lastKey.current = key;
    if (state !== 'idle') setState('idle');
  }

  if (!live) {
    return (
      <p className="text-label text-text-faint">
        The full transcript is available in{' '}
        <code className="font-mono text-text-dim">runray view</code> — an
        exported file carries only previews.
      </p>
    );
  }

  if (state === 'idle') {
    return (
      <button
        type="button"
        onClick={() => {
          setState('loading');
          void fetchTranscript(runId, spanId).then((s) => {
            // ignore a stale response after the user hopped spans
            if (lastKey.current === key) setState(s);
          });
        }}
        className="rounded-control border border-border bg-surface px-2 py-0.5 text-label text-text-dim transition-colors duration-150 ease-out hover:bg-surface-2 hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-brass active:bg-bg"
      >
        Load full transcript
      </button>
    );
  }
  if (state === 'loading') {
    return <p className="text-label text-text-faint">loading…</p>;
  }
  if (state.status === 'redacted') {
    return (
      <p className="text-label text-text-faint">
        Redacted — this viewer runs with{' '}
        <code className="font-mono">--redact</code>; no raw log text reaches the
        browser.
      </p>
    );
  }
  if (state.status === 'unsupported') {
    return (
      <p className="text-label text-text-faint">
        OTLP imports carry no readable transcript.
      </p>
    );
  }
  if (state.status === 'unavailable') {
    return (
      <p className="text-label text-text-faint">
        Transcript unavailable — {state.reason}
      </p>
    );
  }
  if (state.status !== 'ok') return null;
  return <Segments state={state} />;
}

function Segments({
  state,
}: {
  state: Extract<TranscriptState, { status: 'ok' }>;
}) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: state.segments.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 96,
    overscan: 4,
  });
  return (
    <div>
      {state.truncated && (
        <p className="mb-1 micro-label text-heat-2">
          truncated — the slice is capped at 1 MB
        </p>
      )}
      <div
        ref={parentRef}
        className="max-h-80 overflow-y-auto rounded-control border border-border bg-bg"
      >
        <div
          className="relative w-full"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualizer.getVirtualItems().map((item) => {
            const segment = state.segments[item.index];
            if (segment === undefined) return null;
            return (
              <div
                key={item.key}
                ref={virtualizer.measureElement}
                data-index={item.index}
                className="absolute left-0 top-0 w-full border-b border-border/60 p-2"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <p className="micro-label text-text-faint">{segment.label}</p>
                <pre className="mt-0.5 whitespace-pre-wrap break-words font-mono text-label leading-[1.45] text-text-dim">
                  {segment.text}
                </pre>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
