import React, { Suspense } from 'react';

const isOnboardingEnabled =
  typeof __RUNRAY_ONBOARDING__ !== 'undefined'
    ? __RUNRAY_ONBOARDING__
    : typeof __TRACEPULSE_ONBOARDING__ !== 'undefined'
      ? __TRACEPULSE_ONBOARDING__
      : true;

const RunTourLazy = isOnboardingEnabled
  ? React.lazy(() => import('./RunTour'))
  : null;

export function RunTourContainer() {
  if (!RunTourLazy) return null;
  return (
    <Suspense fallback={null}>
      <RunTourLazy />
    </Suspense>
  );
}
