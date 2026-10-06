import { useCallback, useEffect, useRef, useState } from 'react';

export type CopyState = 'idle' | 'copied' | 'failed';

/**
 * Put text on the clipboard and report how it went. A confirmation clears
 * after `resetMs`; a failure stays until the next attempt, so the person
 * has time to read it. The outcome belongs to the text that was copied:
 * a control whose text changes (another span, another export profile)
 * reads idle again rather than confirming something it no longer shows.
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
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = useCallback(
    async (text: string) => {
      clearTimeout(timer.current);
      try {
        // no async clipboard on insecure origins or in older browsers
        if (!navigator.clipboard?.writeText) {
          throw new Error('Clipboard API unavailable');
        }
        await navigator.clipboard.writeText(text);
        setLast({ text, state: 'copied' });
        timer.current = setTimeout(() => setLast(null), resetMs);
      } catch {
        setLast({ text, state: 'failed' });
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
