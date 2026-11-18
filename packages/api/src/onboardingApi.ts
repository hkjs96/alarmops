/**
 * API-CONTRACT §8.4 customer onboarding (hkjs96/alarmops#62), the customer and AWS-account part:
 *   POST   /customers                    create a customer (ADMIN, all-customer range)
 *   GET    /customers/{id}/accounts      list
 *   POST   /customers/{id}/accounts      register an AWS account: 12 digits, server-made ExternalId, role ARNs, capability toggles
 *   PATCH  /accounts/{id}                alias / environment / regions / service / capability toggles
 *   DELETE /accounts/{id}                only an account we have created nothing for (no Resource / ManagedAlarm rows)
 *   POST   /accounts/{id}/check          CHECK_CONNECTION on the alarm-commands queue -> 202 { commandId }
 *   GET    /accounts/{id}/status         per-role status, first / last event received
 *
 * MSP staff only: for portal users none of these routes exist (the one 404). Every account is reached through its
 * customer, inside the query (`findAccount(scope, id)`); another tenant's account and an unknown id are the same 404.
 * The ExternalId is generated here from 32 random bytes and is never read from a request. Role ARNs are derived from
 * the AWS account id and the fixed role names of infra/customer-stack/template.yaml — a client cannot name an ARN the
 * engine would later assume. Neither the ExternalId nor a token is written to an audit row or a log.
 */
import { randomBytes } from 'node:crypto';
import { customerWide, requireAuth, requireRole, scopeOf, type AuthContext } from './auth.js';
import { adminCustomer, type CommandPublisher } from './customerApi.js';
import { rateLimited, withoutUndefined, ApiError, invalid, isRecord, notFound, ok, validation, type ApiRequest, type ApiResponse } from './http.js';
import type { AccountPatch, ApiRepository, CloudAccountRecord, EnvironmentValue, NewAccount, RoleStatusValue } from './repo.js';
import { RESERVED_SLUGS, slugProblem } from './slug.js';

interface Deps { repo: ApiRepository; now: () => Date; commands?: CommandPublisher; log?: (level: 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void }

const ENVIRONMENTS: readonly EnvironmentValue[] = ['PRD', 'STG', 'DEV'];
const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/;
const AWS_ACCOUNT_RE = /^\d{12}$/;
const ALIAS_MAX = 64;
const NAME_MAX = 80;
const CONTROL = /[\u0000-\u001f\u007f]/;
const DOMAIN_RE = /^(?=.{3,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Portal login is granted by e-mail domain: a public mail provider would let anyone sign up as the customer (security review R-7). */
export const FREE_MAIL_DOMAINS: readonly string[] = [
  'gmail.com', 'googlemail.com', 'naver.com', 'daum.net', 'hanmail.net', 'kakao.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'proton.me', 'protonmail.com',
  'nate.com', 'msn.com', 'aol.com', 'gmx.com', 'gmx.net', 'mail.com', 'yandex.com', 'yandex.ru', 'qq.com', '163.com', 'me.com', 'pm.me',
];
export const isFreeMail = (d: string): boolean => FREE_MAIL_DOMAINS.some((f) => d === f || d.endsWith(`.${f}`));

const internalOnly = (auth: AuthContext): void => { if (auth.kind !== 'INTERNAL') throw notFound(); };

// ───────────────────────────── POST /customers ─────────────────────────────

/** The slug a name makes (DATA-MODEL "slug 규칙"): lowercase, other characters become `-`; empty (e.g. Korean only) -> `customer`. */
export function slugFromName(name: string, fallback = 'customer'): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56);
  return base || fallback;
}
/** `base`, then `base-2`, `base-3`… until it is free and not reserved. */
export function freeSlug(base: string, taken: ReadonlySet<string>): string {
  const ok_ = (s: string): boolean => !taken.has(s) && !RESERVED_SLUGS.includes(s) && slugProblem(s) === null;
  if (ok_(base)) return base;
  for (let n = 2; n < 10_000; n++) { const s = `${base}-${n}`; if (ok_(s)) return s; }
  throw new Error('no free slug');
}

/** A customer / project / service name: 1-80 characters, no control characters (400 otherwise). */
export function readName(v: unknown): string {
  const name = typeof v === 'string' ? v.trim() : '';
  if (!name || name.length > NAME_MAX || CONTROL.test(name)) throw invalid('name', `name is required (1-${NAME_MAX} characters).`);
  return name;
}
/** `loginDomains` of POST and PATCH /customers: at most 10, strict syntax (400), lower-case, no public mail domain (422). */
export function readLoginDomains(v: unknown): string[] {
  if (!Array.isArray(v) || v.length > 10) throw invalid('loginDomains', 'loginDomains must be a list of at most 10 domains.');
  const loginDomains = [...new Set(v.map((d) => (typeof d === 'string' ? d.trim().toLowerCase() : '')))];
  if (loginDomains.some((d) => !DOMAIN_RE.test(d))) throw invalid('loginDomains', 'Each login domain must look like example.com.');
  if (loginDomains.some(isFreeMail)) throw new ApiError(422, 'VALIDATION_FAILED', 'A public mail domain cannot be a login domain. Use the customer’s own company domain.', { fields: [{ field: 'loginDomains', message: 'Public mail domain.' }] });
  return loginDomains;
}

export async function createCustomer(req: ApiRequest, deps: Deps): Promise<ApiResponse> {
  const auth = requireAuth(req);
  internalOnly(auth);
  requireRole(auth, 'ADMIN');
  // A new customer is in nobody's narrowed range: only staff who see every customer may create one.
  if (auth.customerIds !== '*') throw new ApiError(403, 'FORBIDDEN', 'Creating a customer needs access to all customers.');
  if (!isRecord(req.body)) throw invalid('body', 'Body must be a JSON object.');
  const b = withoutUndefined(req.body);
  const unknown = Object.keys(b).filter((k) => !['name', 'slug', 'loginDomains'].includes(k));
  if (unknown.length) throw validation(unknown.map((field) => ({ field, message: 'Not accepted here.' })));
  const name = readName(b.name);
  if (b.slug !== undefined) {
    const p = slugProblem(b.slug);
    if (p === 'FORMAT') throw invalid('slug', 'slug must be lowercase letters, digits and "-" (1-64 characters, not starting with "-").');
    if (p === 'RESERVED') throw invalid('slug', 'That slug is reserved.');
  }
  const loginDomains = b.loginDomains !== undefined ? readLoginDomains(b.loginDomains) : [];

  const tree = await deps.repo.orgTree({ customerIds: '*', unmapped: false, subScopes: [] });
  const dup = tree.customers.find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (dup) throw new ApiError(409, 'ALREADY_EXISTS', 'A customer with this name already exists.', { existingCustomerId: dup.id });
  const taken = new Set(tree.customers.map((c) => c.slug));
  if (typeof b.slug === 'string' && taken.has(b.slug)) throw new ApiError(409, 'ALREADY_EXISTS', 'That slug is already used by another customer.');
  const slug = typeof b.slug === 'string' ? b.slug : freeSlug(slugFromName(name), taken);

  const now = deps.now();
  const r = await deps.repo.createCustomer(
    { name, slug, loginDomains },
    { at: now, actorType: 'USER', actorId: auth.userId, action: 'customer.create', targetType: 'Customer', before: null, after: { name, slug, loginDomains }, requestId: req.requestId },
  );
  if (r === 'NAME_EXISTS') throw new ApiError(409, 'ALREADY_EXISTS', 'A customer with this name already exists.');
  if (r === 'SLUG_EXISTS') throw new ApiError(409, 'ALREADY_EXISTS', 'That slug is already used by another customer.');
  if (r === 'DOMAIN_EXISTS') throw new ApiError(409, 'ALREADY_EXISTS', 'A login domain already belongs to another customer.', { field: 'loginDomains' });
  return ok({ id: r.id, name, slug, status: 'ACTIVE', loginDomains, createdAt: r.createdAt.toISOString() }, { location: `/api/v1/customers/${r.id}` }, 201);
}

// ───────────────────────────── accounts ─────────────────────────────

/** Role names of infra/customer-stack/template.yaml (`AlarmOps-<Role>`). */
const ROLE_NAMES = { reader: 'AlarmOps-Reader', eventForwarder: 'AlarmOps-EventForwarder', alarmWriter: 'AlarmOps-AlarmWriter', tagWriter: 'AlarmOps-TagWriter', remediator: 'AlarmOps-Remediator' } as const;
export const roleArn = (awsAccountId: string, role: keyof typeof ROLE_NAMES): string => `arn:aws:iam::${awsAccountId}:role/${ROLE_NAMES[role]}`;
/** 256 bits; AWS accepts 2-1224 characters of [\w+=,.@:/-]. */
export const newExternalId = (): string => `ao-${randomBytes(32).toString('hex')}`;

type RoleKey = 'reader' | 'eventForwarder' | 'alarmWriter' | 'tagWriter' | 'remediator';
const ROLE_KEYS: readonly RoleKey[] = ['reader', 'eventForwarder', 'alarmWriter', 'tagWriter', 'remediator'];
const roleStatus = (a: CloudAccountRecord, k: RoleKey): RoleStatusValue => a[`${k}Status` as const];
const enabledOf = (a: CloudAccountRecord, k: RoleKey): boolean => (k === 'reader' || k === 'eventForwarder' ? true : a[`${k}Enabled` as const]);

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** What an ADMIN sees of an account. The ExternalId is here (the customer puts it in the stack) and nowhere else. */
function accountView(a: CloudAccountRecord) {
  return {
    id: a.id, customerId: a.customerId, serviceId: a.serviceId, awsAccountId: a.awsAccountId, alias: a.alias, environment: a.environment, regions: a.regions,
    externalId: a.externalId,
    readerRoleArn: a.readerRoleArn, eventForwarderRoleArn: a.eventForwarderRoleArn, alarmWriterRoleArn: a.alarmWriterRoleArn, tagWriterRoleArn: a.tagWriterRoleArn, remediatorRoleArn: a.remediatorRoleArn,
    alarmWriterEnabled: a.alarmWriterEnabled, tagWriterEnabled: a.tagWriterEnabled, remediatorEnabled: a.remediatorEnabled,
    stackVersion: a.stackVersion, disabled: a.disabled, lastCheckedAt: iso(a.lastCheckedAt), createdAt: a.createdAt.toISOString(),
  };
}

/** Customer-wide staff only, account found through its customer inside the query. */
async function accountOf(req: ApiRequest, deps: Deps, accountId: string, admin: boolean) {
  const auth = requireAuth(req);
  internalOnly(auth);
  const scope = scopeOf(auth);
  const account = await deps.repo.findAccount(scope, accountId);
  if (!account || !customerWide(scope, account.customerId)) throw notFound();
  if (admin) requireRole(auth, 'ADMIN'); // after the 404: an unknown id never reveals a role rule
  return { auth, account };
}

export async function listAccounts(req: ApiRequest, deps: Deps, customerId: string): Promise<ApiResponse> {
  const { customer } = await adminCustomer(req, deps, customerId, true);
  return ok({ items: (await deps.repo.listAccounts(customer.id)).map(accountView) }, { 'cache-control': 'no-store' }); // carries the ExternalId
}

const CAPS = ['alarmWriterEnabled', 'tagWriterEnabled', 'remediatorEnabled'] as const;
const CAP_ROLE = { alarmWriterEnabled: 'alarmWriter', tagWriterEnabled: 'tagWriter', remediatorEnabled: 'remediator' } as const;
const ARN_FIELD = { alarmWriter: 'alarmWriterRoleArn', tagWriter: 'tagWriterRoleArn', remediator: 'remediatorRoleArn' } as const;

/** Shared by POST and PATCH. Unknown keys are refused — `externalId` and every `*RoleArn` included, they are server-made. */
function readAccountFields(b: Record<string, unknown>, allowAwsId: boolean): Partial<Omit<NewAccount, 'externalId' | `${string}RoleArn`>> {
  const allowed = ['alias', 'environment', 'regions', 'serviceId', ...CAPS, ...(allowAwsId ? ['awsAccountId'] : [])];
  const bad = Object.keys(b).filter((k) => !allowed.includes(k));
  if (bad.length) throw validation(bad.map((field) => ({ field, message: /externalId|RoleArn/.test(field) ? 'Generated by the server; it cannot be set.' : 'Not accepted here.' })));
  const out: Record<string, unknown> = {};
  if (allowAwsId) {
    if (typeof b.awsAccountId !== 'string' || !AWS_ACCOUNT_RE.test(b.awsAccountId)) throw invalid('awsAccountId', 'awsAccountId must be exactly 12 digits (as text).');
    out.awsAccountId = b.awsAccountId;
  }
  if ('alias' in b) {
    if (b.alias !== null && (typeof b.alias !== 'string' || b.alias.trim().length > ALIAS_MAX || CONTROL.test(b.alias))) throw invalid('alias', `alias is text of at most ${ALIAS_MAX} characters.`);
    out.alias = typeof b.alias === 'string' && b.alias.trim() ? b.alias.trim() : null;
  }
  if ('environment' in b) {
    if (b.environment !== null && !(ENVIRONMENTS as readonly unknown[]).includes(b.environment)) throw invalid('environment', 'environment must be PRD, STG, DEV or null.');
    out.environment = b.environment;
  }
  if ('regions' in b) {
    if (!Array.isArray(b.regions) || b.regions.length < 1 || b.regions.length > 10 || b.regions.some((r) => typeof r !== 'string' || !REGION_RE.test(r))) throw invalid('regions', 'regions must be 1-10 AWS region names such as ap-northeast-2.');
    out.regions = [...new Set(b.regions as string[])];
  }
  if ('serviceId' in b) {
    if (b.serviceId !== null && (typeof b.serviceId !== 'string' || !b.serviceId || b.serviceId.length > 200 || CONTROL.test(b.serviceId))) throw invalid('serviceId', 'serviceId must be a service id or null.');
    out.serviceId = b.serviceId;
  }
  for (const k of CAPS) {
    if (k in b && typeof b[k] !== 'boolean') throw invalid(k, `${k} must be true or false.`);
    if (k in b) out[k] = b[k];
  }
  return out as Partial<NewAccount>;
}

export async function createAccount(req: ApiRequest, deps: Deps, customerId: string): Promise<ApiResponse> {
  const { auth, customer } = await adminCustomer(req, deps, customerId, true);
  if (!isRecord(req.body)) throw invalid('body', 'Body must be a JSON object.');
  const b = withoutUndefined(req.body);
  const f = readAccountFields(b, true);
  const awsAccountId = f.awsAccountId!;
  const enabled = { alarmWriterEnabled: f.alarmWriterEnabled ?? false, tagWriterEnabled: f.tagWriterEnabled ?? false, remediatorEnabled: f.remediatorEnabled ?? false };
  const a: NewAccount = {
    awsAccountId, alias: f.alias ?? null, environment: f.environment ?? null, regions: f.regions ?? ['ap-northeast-2'], serviceId: f.serviceId ?? null,
    externalId: newExternalId(),
    readerRoleArn: roleArn(awsAccountId, 'reader'), eventForwarderRoleArn: roleArn(awsAccountId, 'eventForwarder'),
    alarmWriterRoleArn: enabled.alarmWriterEnabled ? roleArn(awsAccountId, 'alarmWriter') : null,
    tagWriterRoleArn: enabled.tagWriterEnabled ? roleArn(awsAccountId, 'tagWriter') : null,
    remediatorRoleArn: enabled.remediatorEnabled ? roleArn(awsAccountId, 'remediator') : null,
    ...enabled,
  };
  const r = await deps.repo.createAccount(customer.id, a, {
    at: deps.now(), actorType: 'USER', actorId: auth.userId, action: 'account.create', targetType: 'CloudAccount',
    before: null, after: { awsAccountId, alias: a.alias, environment: a.environment, regions: a.regions, serviceId: a.serviceId, ...enabled }, requestId: req.requestId,
  });
  if (r === 'EXISTS') throw new ApiError(409, 'ALREADY_EXISTS', 'This AWS account is already registered.');
  if (r === 'NO_SUCH_SERVICE' || r === 'NOT_FOUND') throw notFound();
  if (r === 'CUSTOMER_TERMINATED') throw new ApiError(409, 'CUSTOMER_TERMINATED', 'A terminated customer cannot get new accounts.');
  return ok(accountView(r), { 'cache-control': 'no-store' }, 201);
}

export async function patchAccount(req: ApiRequest, deps: Deps, accountId: string): Promise<ApiResponse> {
  const { auth, account } = await accountOf(req, deps, accountId, true);
  if (!isRecord(req.body)) throw invalid('body', 'Body must be a JSON object.');
  const b = withoutUndefined(req.body);
  const f = readAccountFields(b, false);
  if (Object.keys(f).length === 0) throw invalid('body', 'Nothing to change.');
  const patch: AccountPatch = { ...f };
  // A capability toggle also sets or clears the role ARN (the ARN is derived, never taken from the request).
  for (const k of CAPS) {
    if (f[k] === undefined) continue;
    const role = CAP_ROLE[k];
    patch[ARN_FIELD[role]] = f[k] ? roleArn(account.awsAccountId, role) : null;
  }
  const changed = Object.fromEntries(Object.entries(f));
  const before = Object.fromEntries(Object.keys(f).map((k) => [k, (account as unknown as Record<string, unknown>)[k]]));
  const r = await deps.repo.updateAccount(account.customerId, account.id, patch, {
    at: deps.now(), actorType: 'USER', actorId: auth.userId, action: 'account.update', targetType: 'CloudAccount', before, after: changed, requestId: req.requestId,
  });
  if (r === 'NOT_FOUND' || r === 'NO_SUCH_SERVICE') throw notFound();
  if (r === 'CUSTOMER_TERMINATED') throw new ApiError(409, 'CUSTOMER_TERMINATED', 'A terminated customer cannot change accounts.');
  if (r === 'EXISTS') throw new ApiError(409, 'ALREADY_EXISTS', 'Conflict.');
  return ok(accountView(r), { 'cache-control': 'no-store' });
}

export async function deleteAccount(req: ApiRequest, deps: Deps, accountId: string): Promise<ApiResponse> {
  const { auth, account } = await accountOf(req, deps, accountId, true);
  const r = await deps.repo.deleteAccount(account.customerId, account.id, {
    at: deps.now(), actorType: 'USER', actorId: auth.userId, action: 'account.delete', targetType: 'CloudAccount', before: { awsAccountId: account.awsAccountId, alias: account.alias }, after: null, requestId: req.requestId,
  });
  if (r === 'NOT_FOUND') throw notFound();
  if (r === 'IN_USE') throw new ApiError(409, 'IN_USE', 'Alarms or resources were already created for this account. Terminate the customer to offboard it, or keep the account.');
  if (r === 'CUSTOMER_TERMINATED') throw new ApiError(409, 'CUSTOMER_TERMINATED', 'A terminated customer cannot change accounts.');
  return ok({ id: account.id, deleted: true });
}

// ───────────────────────────── check / status ─────────────────────────────

/** One check per account every 30 s: each one is five AssumeRole calls in the customer's account. Counted from the stored audit row, so it holds across instances. */
export const CHECK_COOLDOWN_SEC = 30;

/** One id per request: a repeated Check connection is a new command, not a duplicate the engine would drop. */
const newCommandId = (): string => `cmd_${randomBytes(12).toString('hex')}`;

/**
 * Publishes CHECK_CONNECTION (engine: AssumeRole per role with the ExternalId, writes the role statuses and
 * `lastCheckedAt`). No publisher -> 503 before anything is written; a failed publish -> 502 (no queue text).
 * The result is read with GET /accounts/{id}/status: poll until `lastCheckedAt` moves.
 */
export async function checkAccount(req: ApiRequest, deps: Deps, accountId: string): Promise<ApiResponse> {
  const { auth, account } = await accountOf(req, deps, accountId, true);
  if (!deps.commands) throw new ApiError(503, 'COMMANDS_UNAVAILABLE', 'The command queue is not configured; the connection was not checked.');
  const st = await deps.repo.customerStatusState(account.customerId);
  if (!st) throw notFound();
  if (st.status === 'TERMINATED' || account.disabled || account.connectionPurged) throw new ApiError(409, 'ACCOUNT_DISABLED', 'This account is disabled; its connection cannot be checked.');
  const now = deps.now();
  const commandId = newCommandId();
  // Reserve first (atomic check-then-record, the `account.check` row IS the limit), publish second: parallel requests cannot all pass,
  // and a failed audit write stops the request before anything is queued. A failed publish keeps the reservation (30 s).
  const slot = await deps.repo.reserveAccountCheck(account.customerId, account.id, now, CHECK_COOLDOWN_SEC,
    { at: now, actorType: 'USER', actorId: auth.userId, action: 'account.check', targetType: 'CloudAccount', before: null, after: { commandId }, requestId: req.requestId });
  if (slot !== 'OK') throw rateLimited('A check for this account was queued a moment ago. Wait for its result.', slot.retryAfterSec);
  const audit = (action: string) => ({ at: now, customerId: account.customerId, actorType: 'USER' as const, actorId: auth.userId, action, targetType: 'CloudAccount', targetId: account.id, before: null, after: { commandId }, requestId: req.requestId });
  try {
    await deps.commands.publish({ schemaVersion: 1, commandId, type: 'CHECK_CONNECTION', customerId: account.customerId, cloudAccountId: account.id, requestedBy: { type: 'USER', id: auth.userId }, requestedAt: now.toISOString(), payload: {} });
  } catch {
    deps.log?.('error', 'check_connection_publish_failed', { requestId: req.requestId, accountId: account.id });
    await deps.repo.recordAudit(audit('account.check_failed')).catch(() => undefined);
    throw new ApiError(502, 'COMMAND_PUBLISH_FAILED', 'The check could not be queued. Try again.');
  }
  return ok({ commandId }, {}, 202);
}

export async function getAccountStatus(req: ApiRequest, deps: Deps, accountId: string): Promise<ApiResponse> {
  const { account } = await accountOf(req, deps, accountId, false);
  const roles = ROLE_KEYS.map((key) => {
    const stored = roleStatus(account, key);
    // The engine's check does not test EventForwarder (its trust is the AWS service, D-47). Events that arrived through it prove it works.
    const fromEvents = key === 'eventForwarder' && stored === 'UNKNOWN' && account.firstEventAt !== null;
    return {
      key, required: key === 'reader' || key === 'eventForwarder', enabled: enabledOf(account, key),
      status: fromEvents ? 'OK' : stored, basis: fromEvents ? 'EVENTS' : 'CHECK',
    };
  });
  return ok({
    accountId: account.id, customerId: account.customerId, awsAccountId: account.awsAccountId, roles,
    lastCheckedAt: iso(account.lastCheckedAt), firstEventAt: iso(account.firstEventAt), lastEventAt: iso(account.lastEventAt), stackVersion: account.stackVersion, disabled: account.disabled,
  });
}
