// Native sidebar layout reserves padding inside a viewport-wide AppFrame.
// Measuring #root + panel width accepted the old double-reservation bug.
export function panelOccupiesLayoutOnce({ viewportWidth, appWidth, frameWidth, framePaddingRight, panelWidth }) {
  const values = [viewportWidth, appWidth, frameWidth, framePaddingRight, panelWidth]
  if (!values.every(value => typeof value === 'number' && Number.isFinite(value))) return false
  if (viewportWidth <= 0 || appWidth <= 0 || frameWidth <= 0 || panelWidth < 0 || panelWidth >= viewportWidth) return false
  return Math.abs(appWidth - viewportWidth) <= 1
    && Math.abs(frameWidth - viewportWidth) <= 1
    && Math.abs(framePaddingRight - panelWidth) <= 1
}
