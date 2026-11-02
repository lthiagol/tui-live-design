/**
 * M9-lite design-name grammar — single source of truth, shared by server
 * routing, the registry, and the client (R3-L3).
 *
 * Lowercase-only (R3-M6): macOS APFS is case-insensitive, so allowing
 * "Foo" and "foo" would silently alias two designs onto one file.
 */
export const DESIGN_NAME_RE = /^[a-z0-9_-]{1,40}$/;

/** The URL path form: /design/<name> — derived from the same grammar. */
export const DESIGN_PATH_RE = /^\/design\/([a-z0-9_-]{1,40})$/;

export function isValidDesignName(name: string): boolean {
  return DESIGN_NAME_RE.test(name);
}
