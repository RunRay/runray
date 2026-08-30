import React, { Suspense } from 'react';

const isOnboardingEnabled =
  typeof __RUNRAY_ONBOARDING__ !== 'undefined'
    ? __RUNRAY_ONBOARDING__
    : typeof __TRACEPULSE_ONBOARDING__ !== 'undefined'
      ? __TRACEPULSE_ONBOARDING__
      : true;

const DashboardTourLazy = isOnboardingEnabled
  ? React.lazy(() => import('./DashboardTour'))
  : null;

export function DashboardTourContainer() {
  if (!DashboardTourLazy) return null;
  return (
    <Suspense fallback={null}>
      <DashboardTourLazy />
    </Suspense>
  );
}
