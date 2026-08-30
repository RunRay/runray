import { useEffect, useSyncExternalStore } from 'react';
import { useAppStore } from '../store';

export type HintKey =
  | 'time-view'
  | 'what-if'
  | 'diff'
  | 'limit-mode'
  | 'coverage'
  | 'redact';

export const HINT_COPY: Record<HintKey, string> = {
  'time-view':
    'Wall clock, not the sum of spans — this is where the waiting actually was.',
  'what-if':
    'Re-price this session against another model. Nothing is sent anywhere.',
  diff: 'Two runs of the same task? Compare them: runray diff <runA> <runB>',
  'limit-mode': 'Reading tokens and % of your weekly limit instead of dollars.',
  coverage:
    'Unpriced models are listed, never guessed — tokens without a dollar figure.',
  redact: 'Exporting? --redact keeps structure and counts, drops prompt text.',
};

const STORAGE_KEY = 'runray.dismissedHints';

export function getDismissedHints(): string[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw =
      localStorage.getItem(STORAGE_KEY) ??
      localStorage.getItem('tracepulse.dismissedHints');
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export function saveDismissedHint(hintKey: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const list = getDismissedHints();
    if (!list.includes(hintKey)) {
      list.push(hintKey);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    }
  } catch {
    // ignore
  }
}

// Global coordinator to ensure AT MOST ONE hint is rendered at a time across components
let currentActiveHintKey: string | null = null;
const subscribers = new Set<() => void>();

function subscribe(callback: () => void) {
  subscribers.add(callback);
  return () => {
    subscribers.delete(callback);
  };
}

function getActiveHintSnapshot() {
  return currentActiveHintKey;
}

function setActiveHint(key: string | null) {
  if (currentActiveHintKey !== key) {
    currentActiveHintKey = key;
    for (const sub of subscribers) sub();
  }
}

export interface ContextualHintProps {
  hintKey: HintKey;
}

export function ContextualHint({ hintKey }: ContextualHintProps) {
  const onboarding = useAppStore((s) => s.onboarding);
  const dismissOnboardingHint = useAppStore((s) => s.dismissOnboardingHint);
  const activeHintKey = useSyncExternalStore(
    subscribe,
    getActiveHintSnapshot,
    getActiveHintSnapshot,
  );

  const isDismissed =
    onboarding.hints.includes(hintKey) || getDismissedHints().includes(hintKey);

  useEffect(() => {
    return () => {
      if (currentActiveHintKey === hintKey) {
        setActiveHint(null);
      }
    };
  }, [hintKey]);

  useEffect(() => {
    if (!onboarding.enabled || !onboarding.loaded || isDismissed) {
      if (currentActiveHintKey === hintKey) {
        setActiveHint(null);
      }
      return;
    }
    if (currentActiveHintKey === null) {
      setActiveHint(hintKey);
    }
  }, [hintKey, onboarding.enabled, onboarding.loaded, isDismissed]);

  if (!onboarding.enabled || !onboarding.loaded || isDismissed) {
    return null;
  }

  // Only render if this hint is the active one in the coordinator
  if (activeHintKey !== hintKey) {
    return null;
  }

  const handleDismiss = () => {
    saveDismissedHint(hintKey);
    dismissOnboardingHint(hintKey);
    setActiveHint(null);
  };

  const copy = HINT_COPY[hintKey];

  return (
    <div
      role="status"
      className="flex items-center justify-between gap-3 rounded border border-border-slate bg-surface-container-low px-3 py-1.5 text-label text-text-dim"
    >
      <span className="truncate">{copy}</span>
      <button
        type="button"
        onClick={handleDismiss}
        aria-label="Dismiss hint"
        className="shrink-0 text-text-faint hover:text-text focus:outline-none"
      >
        ✕
      </button>
    </div>
  );
}
