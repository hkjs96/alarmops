/**
 * Slugs of customers, projects and services (D-33). They are path segments of the console
 * (`/c/<customer>/<project>/<service>/…`), so a slug must never be a word the router or the API owns.
 * The database enforces the same two rules (`*_slug_chk`, `*_slug_reserved_chk` in the migration); this is the
 * check a create / rename handler runs first, to answer with a field error instead of a constraint violation.
 */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Keep in sync with the `*_slug_reserved_chk` constraints in db/prisma/migrations/0001_init/migration.sql (a test compares them). */
export const RESERVED_SLUGS: readonly string[] = [
  // screen names and the unmapped marker (DATA-MODEL "slug 규칙", D-33)
  'incidents', 'incident', 'monitoring', 'call-order', 'people', 'maintenance', 'thresholds', 'alarms', 'resources', 'settings', 'new', '-',
  // words the API and the console shell own (security review SQL, N-7)
  'api', 'admin', 'all', 'unmapped', 'auth', 'c', 'customers', 'login',
];

export type SlugProblem = 'FORMAT' | 'RESERVED';
/** null = usable. */
export function slugProblem(slug: unknown): SlugProblem | null {
  if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) return 'FORMAT';
  return RESERVED_SLUGS.includes(slug) ? 'RESERVED' : null;
}
export const isValidSlug = (slug: unknown): slug is string => slugProblem(slug) === null;
