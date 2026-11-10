/**
 * API-CONTRACT §8.0 — scope: GET /scope-tree and the slug scope filter shared by every scoped list.
 * Isolation is this response: the console draws what it gets and ships it to the browser (security R-1).
 */
import { pagingHealth, resolvePagingConfig } from '@alarmops/core';
import { requireAuth, scopeKey, scopeOf, type AuthContext, type ScopeFilter } from './auth.js';
import { etag, header, invalid, notFound, ok, q, validation, type ApiRequest, type ApiResponse } from './http.js';
import type { ApiRepository, NodeFilter, OrgTree, ProjectNode, ServiceNode } from './repo.js';

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const truthy = (v: string | undefined): boolean => v === '1' || v === 'true';

export interface ResolvedNode { customer: OrgTree['customers'][number]; project?: ProjectNode; service?: ServiceNode }

/**
 * `?customer=&project=&service=` (slugs) → nodes, looked up ONLY in the caller's scoped tree. An unknown slug and
 * another tenant's slug take the same path and end in the same 404; there is no "found, then denied" step.
 */
export function resolveSlugs(tree: OrgTree, slugs: { customer?: string; project?: string; service?: string }): ResolvedNode | null {
  const errors: Array<{ field: string; message: string }> = [];
  for (const k of ['customer', 'project', 'service'] as const) {
    if (slugs[k] !== undefined && !SLUG_RE.test(slugs[k]!)) errors.push({ field: k, message: `${k} must be a slug (a-z, 0-9, -).` });
  }
  if (slugs.project !== undefined && slugs.customer === undefined) errors.push({ field: 'project', message: 'project needs customer.' });
  if (slugs.service !== undefined && slugs.project === undefined) errors.push({ field: 'service', message: 'service needs project.' });
  if (errors.length) throw validation(errors);
  if (slugs.customer === undefined) return null;
  const customer = tree.customers.find((c) => c.slug === slugs.customer);
  if (!customer) throw notFound();
  if (slugs.project === undefined) return { customer };
  const project = tree.projects.find((p) => p.customerId === customer.id && p.slug === slugs.project);
  if (!project) throw notFound();
  if (slugs.service === undefined) return { customer, project };
  const service = tree.services.find((s) => s.projectId === project.id && s.slug === slugs.service);
  if (!service) throw notFound();
  return { customer, project, service };
}

/**
 * The scope part of a list request (§2 "범위 필터"). `customer` beats `mine`. `mine` is computed from the session
 * user only — no user or contact id is read from the request. Returns null when no scope filter is set.
 */
export async function resolveNodeFilter(req: ApiRequest, repo: ApiRepository, auth: AuthContext, scope: ScopeFilter): Promise<NodeFilter | null> {
  const slugs = { customer: q(req, 'customer'), project: q(req, 'project'), service: q(req, 'service') };
  const customerId = q(req, 'customerId');
  const mineRaw = q(req, 'mine');
  if (mineRaw !== undefined && !['1', 'true', '0', 'false'].includes(mineRaw)) throw invalid('mine', 'mine must be 1 or 0.');
  const tree = await repo.orgTree(scope);
  const node = resolveSlugs(tree, slugs);
  if (customerId !== undefined) {
    const byId = tree.customers.find((c) => c.id === customerId);
    if (!byId || (node && node.customer.id !== byId.id)) throw notFound();
    if (!node) return { customerIds: [byId.id], includeUnmapped: false };
  }
  if (node) return { customerIds: [node.customer.id], projectId: node.project?.id, serviceId: node.service?.id, includeUnmapped: false };
  if (truthy(mineRaw)) {
    const visible = new Set(tree.customers.map((c) => c.id));
    const mine = (await repo.responderCustomerIds(auth.userId)).filter((id) => visible.has(id));
    // Unmapped-account incidents stay in "My customers" for staff: nobody owns them yet (§8.0 list table).
    return { customerIds: mine, includeUnmapped: scope.unmapped };
  }
  return null;
}

/** GET /scope-tree?onlyProblems= */
export async function getScopeTree(req: ApiRequest, deps: { repo: ApiRepository; now: () => Date }): Promise<ApiResponse> {
  const auth = requireAuth(req);
  const scope = scopeOf(auth);
  const onlyProblems = truthy(q(req, 'onlyProblems'));
  const now = deps.now();
  const internal = auth.kind === 'INTERNAL';
  const [tree, counts, mine] = await Promise.all([
    deps.repo.orgTree(scope), deps.repo.openIncidentCounts(scope), internal ? deps.repo.responderCustomerIds(auth.userId) : Promise.resolve([] as string[]),
  ]);
  const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);
  const customers = [];
  for (const c of [...tree.customers].sort(byName)) {
    const mineCounts = counts.filter((x) => x.customerId === c.id);
    const { configs, world } = await deps.repo.pagingContext(c.id);
    const own = (type: 'PROJECT' | 'SERVICE', id: string) => configs.some((cfg) => cfg.scopeType === type && cfg.scopeId === id);
    const node = {
      id: c.id, slug: c.slug, name: c.name,
      mine: internal && mine.includes(c.id),
      openIncidents: mineCounts.reduce((n, x) => n + x.open, 0),
      // MSP-internal: portal users always get "OK" (the field is required by the console type, so it is not dropped).
      callHealth: internal
        ? pagingHealth(resolvePagingConfig(configs, { customerId: c.id })?.config ?? null, world, now, { slackChannelVerified: await deps.repo.slackChannelVerified(c.id) }).level
        : 'OK' as const,
      projects: tree.projects.filter((p) => p.customerId === c.id).sort(byName).map((p) => ({
        id: p.id, slug: p.slug, name: p.name,
        openIncidents: mineCounts.filter((x) => x.projectId === p.id).reduce((n, x) => n + x.open, 0),
        ownSteps: own('PROJECT', p.id),
        services: tree.services.filter((s) => s.projectId === p.id).sort(byName).map((s) => ({
          id: s.id, slug: s.slug, name: s.name,
          openIncidents: mineCounts.filter((x) => x.serviceId === s.id).reduce((n, x) => n + x.open, 0),
          ownSteps: own('SERVICE', s.id),
        })),
      })),
    };
    if (!onlyProblems || node.openIncidents > 0 || node.callHealth !== 'OK') customers.push(node);
  }
  const body = { customers };
  // The caller's range is part of the tag: two users never share an ETag (§8.0 rule 5).
  const tag = etag(scopeKey(auth), String(onlyProblems), JSON.stringify(body));
  if (header(req, 'if-none-match') === tag) return { status: 304, headers: { etag: tag, 'cache-control': 'private, no-cache' } };
  return ok(body, { etag: tag, 'cache-control': 'private, no-cache' });
}
