'use client';

import { useEffect, useState } from 'react';

import { getApiBase } from '@/lib/http/client';

function configuredBase() {
  return (
    process.env.NEXT_PUBLIC_OPEN_API_BASE_URL?.trim() || getApiBase()
  ).replace(/\/+$/, '');
}

export function useOpenApiBase() {
  const [baseUrl, setBaseUrl] = useState(() => `${configuredBase()}/api/v1`);

  useEffect(() => {
    // Resolve relative API hosts against the website without replacing a configured API origin.
    const base = new URL(
      configuredBase() || '/',
      window.location.origin,
    ).href.replace(/\/+$/, '');
    setBaseUrl(`${base}/api/v1`);
  }, []);

  return baseUrl;
}
