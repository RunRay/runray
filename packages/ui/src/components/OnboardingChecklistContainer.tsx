import React, { Suspense } from 'react';

const isOnboardingEnabled =
  typeof __RUNRAY_ONBOARDING__ !== 'undefined'
    ? __RUNRAY_ONBOARDING__
    : typeof __TRACEPULSE_ONBOARDING__ !== 'undefined'
      ? __TRACEPULSE_ONBOARDING__
      : true;

const OnboardingChecklistLazy = isOnboardingEnabled
  ? React.lazy(() => import('./OnboardingChecklist'))
  : null;

export function OnboardingChecklistContainer() {
  if (!OnboardingChecklistLazy) return null;
  return (
    <Suspense fallback={null}>
      <OnboardingChecklistLazy />
    </Suspense>
  );
}
