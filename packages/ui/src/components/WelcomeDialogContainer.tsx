import React, { Suspense } from 'react';

const isOnboardingEnabled =
  typeof __RUNRAY_ONBOARDING__ !== 'undefined'
    ? __RUNRAY_ONBOARDING__
    : typeof __TRACEPULSE_ONBOARDING__ !== 'undefined'
      ? __TRACEPULSE_ONBOARDING__
      : true;

const WelcomeDialogLazy = isOnboardingEnabled
  ? React.lazy(() =>
      import('./WelcomeDialog').then((m) => ({ default: m.WelcomeDialog })),
    )
  : null;

export function WelcomeDialogContainer() {
  if (!WelcomeDialogLazy) return null;
  return (
    <Suspense fallback={null}>
      <WelcomeDialogLazy />
    </Suspense>
  );
}
