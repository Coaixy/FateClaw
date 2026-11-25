export function isOpenCodeGoBaseUrl(baseUrl: string): boolean {
  const url = URL.parse(baseUrl);
  return (
    url?.origin === 'https://opencode.ai' &&
    /^\/(?:inference|zen)\/go(?:\/|$)/.test(url.pathname)
  );
}

export function openCodeGoHeaders(sessionId: string): Record<string, string> {
  return {
    'x-opencode-session': sessionId,
    'User-Agent': 'FateClaw',
  };
}
