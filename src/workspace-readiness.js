/**
 * Owns the public workspace-ready state independently from Harness navigation
 * authority. A server may publish its origin before Chromium has completed the
 * workspace load and management overview transition; only this owner may
 * promote that generation/server pair to the public ready/open surface.
 */
export function createWorkspaceReadinessOwner({
  isCurrent = () => false,
  isPublished = () => false,
  isWindowOpen = () => true,
  onChange = () => {},
} = {}) {
  if (typeof isCurrent !== 'function') throw new TypeError('Invalid readiness generation predicate')
  if (typeof isPublished !== 'function') throw new TypeError('Invalid readiness publication predicate')
  if (typeof isWindowOpen !== 'function') throw new TypeError('Invalid readiness window predicate')
  if (typeof onChange !== 'function') throw new TypeError('Invalid readiness state callback')

  let publication

  function changed() {
    try { onChange() } catch { /* status publication must not break lifecycle ownership */ }
  }

  function reset() {
    if (publication === undefined) return false
    publication = undefined
    changed()
    return true
  }

  function markReady(generation, harnessServer) {
    if (!isCurrent(generation) || !isPublished(generation, harnessServer) || !isWindowOpen()) return false
    publication = Object.freeze({ generation, server: harnessServer })
    changed()
    return true
  }

  function isReady() {
    return publication !== undefined
      && isCurrent(publication.generation)
      && isPublished(publication.generation, publication.server)
      && isWindowOpen()
  }

  return Object.freeze({
    isReady,
    markReady,
    reset,
    get publication() { return publication },
  })
}
