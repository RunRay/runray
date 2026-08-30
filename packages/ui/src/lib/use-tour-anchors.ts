import { useEffect, useMemo, useState } from 'react';

export interface TourStepLike {
  /** Candidate `data-tour` keys, in preference order; the first present wins. */
  anchorKeys: readonly string[];
}

/** Resolve a `data-tour` key against the live DOM. */
export function findTourAnchor(key: string): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  return document.querySelector<HTMLElement>(`[data-tour="${key}"]`);
}

function resolveStepAnchor(step: TourStepLike): HTMLElement | null {
  for (const key of step.anchorKeys) {
    const el = findTourAnchor(key);
    if (el !== null) return el;
  }
  return null;
}

/**
 * Resolve tour steps against the DOM, reactively (plan §9: a step whose anchor
 * is absent is skipped and the counter total shrinks).
 *
 * Anchors mount and unmount as routes render and the waterfall virtualizes, so
 * the resolved set is React state fed by a MutationObserver. It deliberately is
 * NOT a `useMemo`: a memo that reads the DOM has no honest dependency list, so
 * it either goes stale against a subtree that mounted after the first render or
 * lies about what it depends on.
 */
export function useTourAnchors<T extends TourStepLike>(
  steps: readonly T[],
  stepIndex: number,
  enabled: boolean,
): { validSteps: T[]; anchorEl: HTMLElement | null } {
  const [presentKeys, setPresentKeys] = useState<readonly string[]>([]);
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!enabled || typeof document === 'undefined') {
      setPresentKeys((prev) => (prev.length === 0 ? prev : []));
      setAnchorEl((prev) => (prev === null ? prev : null));
      return;
    }

    let frame = 0;
    const scan = (): void => {
      frame = 0;
      const present: string[] = [];
      const resolved: Array<HTMLElement> = [];
      for (const step of steps) {
        const el = resolveStepAnchor(step);
        if (el !== null) {
          present.push(step.anchorKeys[0] as string);
          resolved.push(el);
        }
      }
      setPresentKeys((prev) =>
        prev.length === present.length && prev.every((k, i) => k === present[i])
          ? prev
          : present,
      );
      const next = resolved[stepIndex] ?? null;
      setAnchorEl((prev) => (prev === next ? prev : next));
    };

    scan();

    if (typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(() => {
      if (frame !== 0) return;
      frame =
        typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame(scan)
          : (setTimeout(scan, 0) as unknown as number);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      if (frame !== 0 && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(frame);
      }
    };
  }, [steps, stepIndex, enabled]);

  const validSteps = useMemo(
    () => steps.filter((s) => presentKeys.includes(s.anchorKeys[0] as string)),
    [steps, presentKeys],
  );

  return { validSteps, anchorEl };
}
