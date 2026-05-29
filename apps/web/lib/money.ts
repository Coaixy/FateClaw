const CENTS_PER_YUAN = 100;

export function formatCents(cents: number): string {
  return `软妹币 ${(cents / CENTS_PER_YUAN).toFixed(2)}`;
}

export function formatSignedCents(cents: number): string {
  const sign = cents > 0 ? '+' : cents < 0 ? '-' : '';
  return `${sign}${formatCents(Math.abs(cents))}`;
}
