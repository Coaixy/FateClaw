/** Conservative text estimate for legacy outbox usage without provider token counts. */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  let cjk = 0;
  let other = 0;

  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (
      (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
      (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
      (code >= 0x3000 && code <= 0x303f) || // CJK Symbols & Punctuation
      (code >= 0xff00 && code <= 0xffef) || // Fullwidth Forms
      (code >= 0xf900 && code <= 0xfaff) // CJK Compatibility Ideographs
    ) {
      cjk++;
    } else {
      other++;
    }
  }

  // 偏保守：CJK 按 1.2 chars/token，ASCII 按 3.5 chars/token
  return Math.ceil(cjk / 1.2 + other / 3.5);
}
