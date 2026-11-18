/**
 * API-CONTRACT §8.4 onboarding wizard routes (hkjs96/alarmops#69):
 *   GET   /customers                   customers inside the caller's scope, with status
 *   GET   /customers/{id}              one customer (profile)
 *   PATCH /customers/{id}              name, loginDomains (ADMIN). Never `status` (own endpoint) and never `slug` (D-33).
 *   GET   /customers/{id}/projects     POST (ADMIN) { name, slug? }
 *   PATCH /projects/{id}               { name } (ADMIN)
 *   GET   /projects/{id}/services      POST (ADMIN) { name, slug? }
 *   PATCH /services/{id}               { name } (ADMIN)
 * MSP staff only (portal users: the one 404). A customer, project or service is found with the scope INSIDE the query and
 * needs the whole customer in scope (a staff range narrowed to a project cannot edit the structure): unknown and out-of-scope ids
 * are the same 404, before any role check. Names are unique per parent, case-insensitively (409 ALREADY_EXISTS); slugs follow the
 * existing rules (slug.ts: format, reserved words) and are made from the name when not given. No DELETE: a project or service
 * is referenced by incidents, accounts and paging settings; removing one is not a wizard step.
 */
import { customerWide, requireAuth, requireRole, scopeOf, type AuthContext } from './auth.js';
import { adminCustomer } from './customerApi.js';
import { ApiError, invalid, isRecord, notFound, ok, validation, withoutUndefined, type ApiRequest, type ApiResponse } from './http.js';
import { freeSlug, readLoginDomains, readName, slugFromName } from './onboardingApi.js';
import type { ApiRepository, CustomerProfile, ProjectRecord, ServiceRecord } from './repo.js';
import { slugProblem } from './slug.js';

interface Deps { repo: ApiRepository; now: () => Date }

const internalOnly = (auth: AuthContext): void => { if (auth.kind !== 'INTERNAL') throw notFound(); };
const customerView = (c: CustomerProfile) => ({ id: c.id, name: c.name, slug: c.slug, status: c.status, loginDomains: c.loginDomains, createdAt: c.createdAt.toISOString() });
const projectView = (p: ProjectRecord) => ({ id: p.id, customerId: p.customerId, name: p.name, slug: p.slug, serviceCount: p.serviceCount });
const serviceView = (s: ServiceRecord) => ({ id: s.id, customerId: s.customerId, projectId: s.projectId, name: s.name, slug: s.slug });

// ───────────────────────────── customers ─────────────────────────────

export async function listCustomers(req: ApiRequest, deps: Deps): Promise<ApiResponse> {
  const auth = requireAuth(req);
  internalOnly(auth);
  const scope = scopeOf(auth);
  const items = (await deps.repo.listCustomers(scope)).filter((c) => customerWide(scope, c.id));
  return ok({ items: items.map(customerView) });
}

export async function getCustomer(req: ApiRequest, deps: Deps, customerId: string): Promise<ApiResponse> {
  const auth = requireAuth(req);
  internalOnly(auth);
  const scope = scopeOf(auth);
  const c = await deps.repo.findCustomer(scope, customerId);
  if (!c || !customerWide(scope, c.id)) throw notFound();
  return ok(customerView(c));
}

export async function patchCustomer(req: ApiRequest, deps: Deps, customerId: string): Promise<ApiResponse> {
  const { auth, customer } = await adminCustomer(req, deps, customerId, true);
  if (!isRecord(req.body)) throw invalid('body', 'Body must be a JSON object.');
  const b = withoutUndefined(req.body);
  const bad = Object.keys(b).filter((k) => !['name', 'loginDomains'].includes(k));
  if (bad.length) throw validation(bad.map((field) => ({ field, message: field === 'status' ? 'Use PATCH /customers/{id}/status.' : field === 'slug' ? 'The slug never changes.' : 'Not accepted here.' })));
  if (Object.keys(b).length === 0) throw invalid('body', 'Nothing to change.');
  const patch: { name?: string; loginDomains?: string[] } = {};
  if ('name' in b) patch.name = readName(b.name);
  if ('loginDomains' in b) patch.loginDomains = readLoginDomains(b.loginDomains);
  const cur = await deps.repo.findCustomer(scopeOf(auth), customer.id);
  if (!cur) throw notFound();
  const before: Record<string, unknown> = {}; const after: Record<string, unknown> = {};
  if (patch.name !== undefined && patch.name !== cur.name) { before.name = cur.name; after.name = patch.name; } else delete patch.name;
  if (patch.loginDomains !== undefined && JSON.stringify([...patch.loginDomains].sort()) !== JSON.stringify([...cur.loginDomains].sort())) { before.loginDomains = cur.loginDomains; after.loginDomains = patch.loginDomains; } else delete patch.loginDomains;
  if (Object.keys(patch).length === 0) return ok({ ...customerView(cur), affectedUsers: 0 }); // nothing differs: no write, no audit row
  // Removing a login domain does NOT sign anybody out: users already enrolled through it stay ACTIVE until an ADMIN disables them
  // (PATCH /users/{id}). `affectedUsers` = how many ACTIVE portal users have an address in a removed domain.
  const removed = patch.loginDomains ? cur.loginDomains.filter((d) => !patch.loginDomains!.includes(d)) : [];
  const affectedUsers = removed.length ? await deps.repo.countPortalUsersInDomains(cur.id, removed) : 0;
  if (removed.length) after.affectedUsers = affectedUsers;
  const r = await deps.repo.updateCustomer(cur.id, patch, { at: deps.now(), actorType: 'USER', actorId: auth.userId, action: 'customer.update', targetType: 'Customer', before, after, requestId: req.requestId });
  if (r === 'NOT_FOUND') throw notFound();
  if (r === 'NAME_EXISTS') throw new ApiError(409, 'ALREADY_EXISTS', 'A customer with this name already exists.');
  if (r === 'DOMAIN_EXISTS') throw new ApiError(409, 'ALREADY_EXISTS', 'A login domain already belongs to another customer.', { field: 'loginDomains' });
  if (r === 'CUSTOMER_TERMINATED') throw new ApiError(409, 'CUSTOMER_TERMINATED', 'A terminated customer cannot be changed.');
  return ok({ ...customerView(r), affectedUsers });
}

// ───────────────────────────── projects ─────────────────────────────

export async function listProjects(req: ApiRequest, deps: Deps, customerId: string): Promise<ApiResponse> {
  const { customer } = await adminCustomer(req, deps, customerId, false);
  return ok({ items: (await deps.repo.listProjects(customer.id)).map(projectView) });
}

/** name + optional slug of a POST; the slug is made from the name (fallback word `project` / `service`) when not given. */
function readNewNode(req: ApiRequest): { name: string; slug: string | null } {
  if (!isRecord(req.body)) throw invalid('body', 'Body must be a JSON object.');
  const b = withoutUndefined(req.body);
  const bad = Object.keys(b).filter((k) => !['name', 'slug'].includes(k));
  if (bad.length) throw validation(bad.map((field) => ({ field, message: 'Not accepted here.' })));
  const name = readName(b.name);
  if (b.slug === undefined) return { name, slug: null };
  const p = slugProblem(b.slug);
  if (p === 'FORMAT') throw invalid('slug', 'slug must be lowercase letters, digits and "-" (1-64 characters, not starting with "-").');
  if (p === 'RESERVED') throw invalid('slug', 'That slug is reserved.');
  return { name, slug: b.slug as string };
}
function readRename(req: ApiRequest): string {
  if (!isRecord(req.body)) throw invalid('body', 'Body must be a JSON object.');
  const b = withoutUndefined(req.body);
  const bad = Object.keys(b).filter((k) => k !== 'name');
  if (bad.length) throw validation(bad.map((field) => ({ field, message: field === 'slug' ? 'The slug never changes.' : 'Not accepted here.' })));
  return readName(b.name);
}
const nameTaken = (what: string): ApiError => new ApiError(409, 'ALREADY_EXISTS', `A ${what} with this name already exists.`);
const slugTaken = (what: string): ApiError => new ApiError(409, 'ALREADY_EXISTS', `That slug is already used by another ${what}.`);
const terminated = (): ApiError => new ApiError(409, 'CUSTOMER_TERMINATED', 'A terminated customer cannot be changed.');

export async function createProject(req: ApiRequest, deps: Deps, customerId: string): Promise<ApiResponse> {
  const { auth, customer } = await adminCustomer(req, deps, customerId, true);
  const n = readNewNode(req);
  const existing = await deps.repo.listProjects(customer.id);
  if (existing.some((p) => p.name.toLowerCase() === n.name.toLowerCase())) throw nameTaken('project');
  const taken = new Set(existing.map((p) => p.slug));
  if (n.slug !== null && taken.has(n.slug)) throw slugTaken('project');
  const slug = n.slug ?? freeSlug(slugFromName(n.name, 'project'), taken);
  const r = await deps.repo.createProject(customer.id, { name: n.name, slug }, { at: deps.now(), actorType: 'USER', actorId: auth.userId, action: 'project.create', targetType: 'Project', before: null, after: { name: n.name, slug }, requestId: req.requestId });
  if (r === 'NOT_FOUND') throw notFound();
  if (r === 'NAME_EXISTS') throw nameTaken('project');
  if (r === 'SLUG_EXISTS') throw slugTaken('project');
  if (r === 'CUSTOMER_TERMINATED') throw terminated();
  return ok(projectView(r), { location: `/api/v1/projects/${r.id}` }, 201);
}

/** The project through the scope (in the query), whole customer in scope; ADMIN checked after the 404. */
async function projectOf(req: ApiRequest, deps: Deps, projectId: string, admin: boolean) {
  const auth = requireAuth(req);
  internalOnly(auth);
  const scope = scopeOf(auth);
  const project = await deps.repo.findProject(scope, projectId);
  if (!project || !customerWide(scope, project.customerId)) throw notFound();
  if (admin) requireRole(auth, 'ADMIN');
  return { auth, project };
}

export async function patchProject(req: ApiRequest, deps: Deps, projectId: string): Promise<ApiResponse> {
  const { auth, project } = await projectOf(req, deps, projectId, true);
  const name = readRename(req);
  if (name === project.name) return ok(projectView(project));
  const r = await deps.repo.updateProject(project.customerId, project.id, { name }, { at: deps.now(), actorType: 'USER', actorId: auth.userId, action: 'project.update', targetType: 'Project', before: { name: project.name }, after: { name }, requestId: req.requestId });
  if (r === 'NOT_FOUND') throw notFound();
  if (r === 'NAME_EXISTS' || r === 'SLUG_EXISTS') throw nameTaken('project');
  if (r === 'CUSTOMER_TERMINATED') throw terminated();
  return ok(projectView(r));
}

// ───────────────────────────── services ─────────────────────────────

export async function listServices(req: ApiRequest, deps: Deps, projectId: string): Promise<ApiResponse> {
  const { project } = await projectOf(req, deps, projectId, false);
  return ok({ items: (await deps.repo.listServices(project.customerId, project.id)).map(serviceView) });
}

export async function createService(req: ApiRequest, deps: Deps, projectId: string): Promise<ApiResponse> {
  const { auth, project } = await projectOf(req, deps, projectId, true);
  const n = readNewNode(req);
  const existing = await deps.repo.listServices(project.customerId, project.id);
  if (existing.some((s) => s.name.toLowerCase() === n.name.toLowerCase())) throw nameTaken('service');
  const taken = new Set(existing.map((s) => s.slug));
  if (n.slug !== null && taken.has(n.slug)) throw slugTaken('service');
  const slug = n.slug ?? freeSlug(slugFromName(n.name, 'service'), taken);
  const r = await deps.repo.createService(project.customerId, project.id, { name: n.name, slug }, { at: deps.now(), actorType: 'USER', actorId: auth.userId, action: 'service.create', targetType: 'Service', before: null, after: { name: n.name, slug, projectId: project.id }, requestId: req.requestId });
  if (r === 'NOT_FOUND') throw notFound();
  if (r === 'NAME_EXISTS') throw nameTaken('service');
  if (r === 'SLUG_EXISTS') throw slugTaken('service');
  if (r === 'CUSTOMER_TERMINATED') throw terminated();
  return ok(serviceView(r), { location: `/api/v1/services/${r.id}` }, 201);
}

export async function patchService(req: ApiRequest, deps: Deps, serviceId: string): Promise<ApiResponse> {
  const auth = requireAuth(req);
  internalOnly(auth);
  const scope = scopeOf(auth);
  const sv = await deps.repo.findService(scope, serviceId);
  if (!sv || !customerWide(scope, sv.customerId)) throw notFound();
  requireRole(auth, 'ADMIN');
  const name = readRename(req);
  if (name === sv.name) return ok(serviceView(sv));
  const r = await deps.repo.updateService(sv.customerId, sv.id, { name }, { at: deps.now(), actorType: 'USER', actorId: auth.userId, action: 'service.update', targetType: 'Service', before: { name: sv.name }, after: { name }, requestId: req.requestId });
  if (r === 'NOT_FOUND') throw notFound();
  if (r === 'NAME_EXISTS' || r === 'SLUG_EXISTS') throw nameTaken('service');
  if (r === 'CUSTOMER_TERMINATED') throw terminated();
  return ok(serviceView(r));
}
