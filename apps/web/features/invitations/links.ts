export function buildRegistrationInviteLink(
  origin: string,
  code: string,
): string {
  const url = new URL('/login', origin);
  // Fragments stay in the browser and cannot enter static-host access logs.
  url.hash = new URLSearchParams({ invite: code }).toString();
  return url.toString();
}

export function readRegistrationInviteFragment(hash: string): string {
  return (
    new URLSearchParams(hash.replace(/^#/, '')).get('invite')?.trim() ?? ''
  );
}
