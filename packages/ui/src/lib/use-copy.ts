import { useCallback, useEffect, useRef, useState } from 'react';

export type CopyState = 'idle' | 'copied' | 'failed';

/**
 * Put text on the clipboard and report how it went. A confirmation clears
 * after `resetMs`; a failure stays until the next attempt, so the person
 * has time to read it. The outcome belongs to the text that was copied:
 * a control whose text changes (another span, another export profile)
 * reads idle again rather than confirming something it no longer shows.
 * Only the latest attempt reports: a slow earlier one that settles after
 * it (a double click, a permission prompt) is dropped.
 */
export function useCopy(resetMs: number): {
  stateOf: (text: string) => CopyState;
  copy: (text: string) => Promise<void>;
} {
  const [last, setLast] = useState<{
    text: string;
    state: 'copied' | 'failed';
  } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const attempt = useRef(0);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      attempt.current += 1; // an attempt still in flight reports to no one
    },
    [],
  );

  const copy = useCallback(
    async (text: string) => {
      attempt.current += 1;
      const id = attempt.current;
      clearTimeout(timer.current);
      let state: 'copied' | 'failed' = 'copied';
      try {
        // no async clipboard on insecure origins or in older browsers
        if (!navigator.clipboard?.writeText) {
          throw new Error('Clipboard API unavailable');
        }
        await navigator.clipboard.writeText(text);
      } catch {
        state = 'failed';
      }
      if (id !== attempt.current) return;
      setLast({ text, state });
      if (state === 'copied') {
        timer.current = setTimeout(() => setLast(null), resetMs);
      }
    },
    [resetMs],
  );

  const stateOf = useCallback(
    (text: string): CopyState => (last?.text === text ? last.state : 'idle'),
    [last],
  );
  return { stateOf, copy };
}
