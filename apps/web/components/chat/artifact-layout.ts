interface ArtifactViewport {
  height: number;
  top: number;
  paddingTop: number;
  paddingBottom: number;
  borderTop: number;
  scrollTop: number;
}

export function getArtifactHeightBudget(
  viewport: ArtifactViewport,
  previewContentTop?: number,
): number {
  let height = viewport.height - viewport.paddingTop - viewport.paddingBottom;
  if (previewContentTop !== undefined) {
    // scrollTop cancels movement inside a preview; scrolling must never resize a board.
    const contentOffset =
      previewContentTop -
      viewport.top +
      viewport.scrollTop -
      viewport.borderTop;
    height -= Math.max(0, contentOffset - viewport.paddingTop);
  }
  // The complete board and its actions share the same visible region.
  return Math.max(1, height - 48);
}
