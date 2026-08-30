/**
 * Helper to emit data-tour attributes conditionally (task 5.1/5.2, D7):
 * When __TRACEPULSE_ONBOARDING__ is false (export build), Rollup dead-code
 * eliminates the 'data-tour' string so it does not leak into dist-export/index.html.
 */
export function tourAttr(key: string): Record<string, string> {
  const enabled =
    typeof __RUNRAY_ONBOARDING__ !== 'undefined'
      ? __RUNRAY_ONBOARDING__
      : typeof __TRACEPULSE_ONBOARDING__ !== 'undefined'
        ? __TRACEPULSE_ONBOARDING__
        : true;
  return enabled ? { 'data-tour': key } : {};
}
