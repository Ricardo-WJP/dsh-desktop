/**
 * Geometry contract for an external fixed page hosted from the shell overlay.
 * The browser implementation uses CSS `right`/`bottom` variables; this pure
 * helper keeps the two independent insets testable without a live DSH window.
 */
export const MNEMON_EXTERNAL_PAGE_SELECTOR = 'section[data-dsh-mnemon-view]'
export const MNEMON_EXTERNAL_PAGE_MARKER = 'data-dsh-desktop-external-page'

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
}

export function mnemonExternalPageSize({
  viewportWidth,
  viewportHeight,
  left = 0,
  top = 0,
  rightInset = 0,
  bottomInset = 0,
}) {
  const width = finiteNonNegative(viewportWidth)
  const height = finiteNonNegative(viewportHeight)
  return {
    width: Math.max(0, width - finiteNonNegative(left) - finiteNonNegative(rightInset)),
    height: Math.max(0, height - finiteNonNegative(top) - finiteNonNegative(bottomInset)),
  }
}
