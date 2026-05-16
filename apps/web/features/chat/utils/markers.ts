const FINAL_TURN_MARKER_RE =
  /\n\n(📥\s+[0-9]+(?:\.[0-9]+)?k?\s+·\s+📤\s+[0-9]+(?:\.[0-9]+)?k?\s+Finished)\s*$/i;

export function splitFinalTurnMarker(content: string): {
  body: string;
  marker: string | null;
} {
  const match = content.match(FINAL_TURN_MARKER_RE);
  if (!match) {
    return { body: content, marker: null };
  }

  const body = content.slice(0, match.index).trimEnd();
  return {
    body,
    marker: match[1].replace(/\s+Finished$/i, ''),
  };
}
