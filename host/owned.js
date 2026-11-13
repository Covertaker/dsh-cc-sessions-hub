/**
 * Session ids the panel currently owns a live process for.
 *
 * Kept in its own dependency-free module so the list route can read it without
 * importing the Agent SDK (a broken chat half must never take the list down).
 */
export const OWNED = new Set()
