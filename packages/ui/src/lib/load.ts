/**
 * Data loading (05-ARCHITECTURE §4): the exported single file injects
 * `window.__RUNRAY_DATA__`; when absent (dev / `runray view`) we fetch
 * the local server's `/api/tracefile`. The fetch targets our own
 * 127.0.0.1-only server — the UI itself never talks to the network.
 */

import type { PricingTable } from '@runray/core/pricing';
import type { TraceFile } from '@runray/schema';
import type { LimitWindowConfig } from './limit-window';

/**
 * Effective pricing delivered by the CLI (C2): embedded in exports beside
 * the data, served at /api/pricing by `view`/`demo`. The UI NEVER bundles a
 * pricing snapshot of its own — a page with no payload hides the what-if
 * panel behind a notice instead of falling back.
 */
export interface PricingPayload {
  origin: 'user' | 'bundled';
  path?: string;
  table: PricingTable;
}

export interface SanitizationManifest {
  profile: 'full' | 'sanitized' | 'metadata-only';
  textRedacted: boolean;
  pathsScrubbed: boolean;
  spansPruned: boolean;
}

/** View configuration delivered by the CLI (E1): `{ limitWindow?, manifest? }`. */
export interface ViewConfigPayload {
  limitWindow?: LimitWindowConfig;
  manifest?: SanitizationManifest;
  /** Live-only (§4.7): the roots discovery checked, `~`-abbreviated by the
   * CLI. Never present in an export — see plan constraint 6. */
  rootsScanned?: Array<{
    path: string;
    verdict: 'missing' | 'empty' | 'unreadable';
  }>;
  isSample?: boolean;
}

export interface OnboardingBlock {
  welcomeDismissedAt?: string | null;
  tours?: Record<string, string>;
  hints?: string[];
  checklist?: Record<string, boolean>;
}

declare global {
  interface Window {
    __RUNRAY_DATA__?: TraceFile;
    __RUNRAY_PRICING__?: PricingPayload;
    __RUNRAY_VIEW_CONFIG__?: ViewConfigPayload;
    __TRACEPULSE_DATA__?: TraceFile;
    __TRACEPULSE_PRICING__?: PricingPayload;
    __TRACEPULSE_VIEW_CONFIG__?: ViewConfigPayload;
  }
}

export interface LoadResult {
  traceFile: TraceFile;
  /** True when served by the CLI (refetch on change is possible). */
  live: boolean;
}

export async function loadTraceFile(): Promise<LoadResult> {
  const embedded = window.__RUNRAY_DATA__ ?? window.__TRACEPULSE_DATA__;
  if (embedded !== undefined) {
    return { traceFile: embedded, live: false };
  }
  const res = await fetch('/api/tracefile');
  if (!res.ok) {
    throw new Error(
      `the local server answered ${res.status} for /api/tracefile`,
    );
  }
  return {
    traceFile: (await res.json()) as TraceFile,
    live: true,
  };
}

/**
 * Embedded-first pricing load; a 404 (older CLI) or fetch failure yields
 * `undefined` — repricing surfaces degrade to an explanatory notice.
 */
export async function loadPricing(): Promise<PricingPayload | undefined> {
  const embedded = window.__RUNRAY_PRICING__ ?? window.__TRACEPULSE_PRICING__;
  if (embedded !== undefined) return embedded;
  if (
    window.__RUNRAY_DATA__ !== undefined ||
    window.__TRACEPULSE_DATA__ !== undefined
  )
    return undefined; // old export
  try {
    const res = await fetch('/api/pricing');
    if (!res.ok) return undefined;
    return (await res.json()) as PricingPayload;
  } catch {
    return undefined;
  }
}

/** Embedded-first view config; absent → `{}` (behavior identical to today). */
export async function loadViewConfig(): Promise<ViewConfigPayload> {
  const embedded =
    window.__RUNRAY_VIEW_CONFIG__ ?? window.__TRACEPULSE_VIEW_CONFIG__;
  if (embedded !== undefined) return embedded;
  if (
    window.__RUNRAY_DATA__ !== undefined ||
    window.__TRACEPULSE_DATA__ !== undefined
  )
    return {}; // old export
  try {
    const res = await fetch('/api/viewconfig');
    if (!res.ok) return {};
    return (await res.json()) as ViewConfigPayload;
  } catch {
    return {};
  }
}

/**
 * Embedded-first onboarding state load. Returns undefined when in export mode
 * (window.__RUNRAY_DATA__ / __TRACEPULSE_DATA__ present), when onboarding is false,
 * or when the endpoint fails/404s.
 */
export async function loadOnboarding(): Promise<OnboardingBlock | undefined> {
  const enabled =
    typeof __RUNRAY_ONBOARDING__ !== 'undefined'
      ? __RUNRAY_ONBOARDING__
      : typeof __TRACEPULSE_ONBOARDING__ !== 'undefined'
        ? __TRACEPULSE_ONBOARDING__
        : true;
  if (!enabled) return undefined;
  const win = (typeof window !== 'undefined' ? window : globalThis) as {
    __RUNRAY_DATA__?: unknown;
    __TRACEPULSE_DATA__?: unknown;
  };
  if (
    win.__RUNRAY_DATA__ !== undefined ||
    win.__TRACEPULSE_DATA__ !== undefined
  ) {
    return undefined;
  }
  try {
    const res = await fetch('/api/onboarding');
    if (!res.ok) return undefined;
    return (await res.json()) as OnboardingBlock;
  } catch {
    return undefined;
  }
}

/**
 * POST shallow-merged patch to /api/onboarding. Fails silently on error or export.
 */
export async function postOnboardingPatch(
  patch: OnboardingBlock,
): Promise<OnboardingBlock | undefined> {
  const enabled =
    typeof __RUNRAY_ONBOARDING__ !== 'undefined'
      ? __RUNRAY_ONBOARDING__
      : typeof __TRACEPULSE_ONBOARDING__ !== 'undefined'
        ? __TRACEPULSE_ONBOARDING__
        : true;
  if (!enabled) return undefined;
  const win = (typeof window !== 'undefined' ? window : globalThis) as {
    __RUNRAY_DATA__?: unknown;
    __TRACEPULSE_DATA__?: unknown;
  };
  if (
    win.__RUNRAY_DATA__ !== undefined ||
    win.__TRACEPULSE_DATA__ !== undefined
  ) {
    return undefined;
  }
  try {
    const res = await fetch('/api/onboarding', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) return undefined;
    return (await res.json()) as OnboardingBlock;
  } catch {
    return undefined;
  }
}

/**
 * `--watch` support: the server emits `changed` on `/api/events` (SSE).
 * Without `--watch` the endpoint 404s and the browser closes the stream for
 * good — no retry loop, no error surfaced. Returns an unsubscribe.
 */
export function subscribeToChanges(
  onChange: () => void,
  onStatus?: (connected: boolean) => void,
): () => void {
  const events = new EventSource('/api/events');
  events.addEventListener('changed', onChange);
  // `--watch` is what serves /api/events; without it the endpoint 404s and
  // the EventSource never opens (fires error). Report the connection state
  // so the UI's live indicator reflects an actual event stream, not merely
  // "was served by a server".
  if (onStatus !== undefined) {
    events.onopen = () => onStatus(true);
    events.onerror = () => onStatus(false);
  }
  return () => {
    events.close();
    onStatus?.(false);
  };
}
