'use client';

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

const LEGACY_TAB_REDIRECT: Record<string, string> = {
  personal: '/profile',
  account: '/profile',
  appearance: '/profile',
  wallet: '/membership',
};

function SettingsRedirectInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const tab = searchParams.get('tab') ?? '';
    router.replace(LEGACY_TAB_REDIRECT[tab] ?? '/profile');
  }, [router, searchParams]);

  return null;
}

export default function SettingsRedirect() {
  return (
    <Suspense fallback={null}>
      <SettingsRedirectInner />
    </Suspense>
  );
}
