/**
 * Mock of API-CONTRACT 8.4 onboarding (#62, #69): customers, projects and services, AWS accounts (server-made
 * ExternalId, capability toggles, connection check and status) and customer contacts with verification links.
 * packages/api/src/{onboardingApi,orgApi,contactsApi}.ts are the reference for every rule and message here.
 *
 * Deterministic switches the e2e specs and the unit tests rely on (real API has none of these, the mock needs them
 * because there is no AWS and no sender behind it):
 *
 *   AWS account, by the LAST THREE DIGITS of the 12-digit id — what the "engine" finds when it checks:
 *     401  every enabled role OK, events arrive (EventForwarder OK by events)
 *     402  Reader OK, AlarmWriter DENIED if it is enabled, events arrive            (a failing OPTIONAL role)
 *     403  Reader and every optional role DENIED (the trust policy rejects the role / ExternalId)
 *     404  Reader and every optional role MISSING (the stack is not created yet)
 *     503  POST /accounts/{id}/check answers 503 COMMANDS_UNAVAILABLE (no command queue)
 *     else Reader and enabled optional roles OK, no event yet
 *   The result is written ENGINE_DELAY_MS after the check was queued; `lastCheckedAt` moves then (poll it).
 *   A second check inside 30 s answers 429 RATE_LIMITED with Retry-After / details.retryAfterSec (real clock).
 *
 *   Verification link: e-mail works (LINK_SENT, 24 h); SMS answers 503 VERIFICATION_UNAVAILABLE (no SMS sender), so the
 *   page offers manual verification. The same contact + channel inside 60 s answers 429.
 *
 *   Public verify tokens (GET peeks, POST consumes once): vf_demo_email_1..4 and vf_demo_sms_1 are pending; vf_demo_used and anything else is the same 404.
 *   A link requested through the console is a pending token too (not shown anywhere: there is no mailbox).
 */
import { ApiError, type ConsoleApi } from "../client";
import type {
  AccountCapabilities, AccountRecord, AccountRoleKey, AccountRoleStatus, AccountStatus, ChannelState, ContactChannelInfo, ContactChannelKey, ContactRecord, CustomerRecord,
  ProjectRecord, Role, ServiceRecord, VerifyChannel,
} from "../types";
import { slugify } from "../../scope";
import type { FxCustomer, FxProject } from "./scope-fixtures";
import type { FxPaging } from "./paging-fixtures";

export const ENGINE_DELAY_MS = 1500;
export const CHECK_COOLDOWN_SEC = 30;
export const VERIFY_COOLDOWN_SEC = 60;
export const VERIFY_TTL_MS = 24 * 3600_000;
const FREE_MAIL = ["gmail.com", "googlemail.com", "naver.com", "daum.net", "hanmail.net", "kakao.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com", "icloud.com", "proton.me", "protonmail.com",
  "nate.com", "msn.com", "aol.com", "gmx.com", "gmx.net", "mail.com", "yandex.com", "yandex.ru", "qq.com", "163.com", "me.com", "pm.me"];
const isFreeMail = (d: string) => FREE_MAIL.some((f) => d === f || d.endsWith(`.${f}`));
const DOMAIN_RE = /^(?=.{3,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const ROLE_KEYS: AccountRoleKey[] = ["reader", "eventForwarder", "alarmWriter", "tagWriter", "remediator"];

interface MockAccount extends AccountRecord {
  /** when the queued check will be written (ms, real clock) */
  readyAt: number | null;
  lastCommandAt: number | null;
  roleStatus: Partial<Record<AccountRoleKey, AccountRoleStatus["status"]>>;
  firstEventAt: string | null;
  lastEventAt: string | null;
}
interface MockContact extends ContactRecord { customerId: string; email?: string; phone?: string; meta: Partial<Record<VerifyChannel, { sentAt?: number }>> }
interface MockToken { contactId: string | null; channel: VerifyChannel; used: boolean }
export interface OnboardingStore {
  created: Record<string, CustomerRecord>;
  domains: Record<string, string[]>;
  accounts: MockAccount[];
  contacts: MockContact[];
  tokens: Record<string, MockToken>;
  seq: number;
}

export function createOnboardingStore(): OnboardingStore {
  const tokens: Record<string, MockToken> = {
    vf_demo_email_1: { contactId: null, channel: "EMAIL", used: false }, vf_demo_email_2: { contactId: null, channel: "EMAIL", used: false },
    vf_demo_email_3: { contactId: null, channel: "EMAIL", used: false }, vf_demo_email_4: { contactId: null, channel: "EMAIL", used: false },
    vf_demo_sms_1: { contactId: null, channel: "SMS", used: false }, vf_demo_used: { contactId: null, channel: "EMAIL", used: true },
  };
  return {
    created: {}, domains: {}, tokens, seq: 0, contacts: [],
    accounts: [{
      id: "acc_mirae_1", customerId: "cus_mirae", serviceId: null, awsAccountId: "481220935017", alias: "mirae-prod", environment: "PRD", regions: ["ap-northeast-2"],
      externalId: externalIdFor("481220935017", 0), alarmWriterEnabled: true, tagWriterEnabled: false, remediatorEnabled: false, stackVersion: "1.0.0", disabled: false,
      lastCheckedAt: "2026-11-09T01:00:00Z", createdAt: "2026-10-01T00:00:00Z", readyAt: null, lastCommandAt: null,
      roleStatus: { reader: "OK", eventForwarder: "OK", alarmWriter: "OK" }, firstEventAt: "2026-10-02T00:00:00Z", lastEventAt: "2026-11-09T00:55:00Z",
    }],
  };
}

/** `ao-` + 64 hex characters, the shape the server makes (256 random bits); here derived from the account id and a counter. */
export function externalIdFor(awsAccountId: string, n: number): string {
  let h = 2166136261 ^ n;
  let out = "";
  for (let i = 0; out.length < 64; i++) {
    h = Math.imul(h ^ (awsAccountId.charCodeAt(i % awsAccountId.length) + i), 16777619) >>> 0;
    out += h.toString(16).padStart(8, "0");
  }
  return `ao-${out.slice(0, 64)}`;
}

interface Ctx {
  store: OnboardingStore;
  customers: FxCustomer[];
  paging: FxPaging;
  me: { id: string; name: string; role: Role };
  portal?: boolean;
  /** the real clock (cooldowns, the engine's delay); `now` of the other mocks is frozen */
  clock: () => number;
  need: (role: Role) => void;
  err: (status: number, code: string, message: string, details?: Record<string, unknown>) => ApiError;
}

type OnboardingApi = Pick<ConsoleApi, "createCustomer" | "getCustomer" | "listProjects" | "createProject" | "listServices" | "createService" | "listAccounts" | "createAccount"
  | "patchAccount" | "checkAccount" | "getAccountStatus" | "listContacts" | "createContact" | "verifyContact" | "verifyBulk" | "peekVerify" | "confirmVerify">;

const maskEmail = (e: string) => { const [l, d] = e.split("@"); return `${l![0]}•••@${d}`; };
const maskPhone = (p: string) => `010-••••-${p.replace(/\D/g, "").slice(-4).padStart(4, "0")}`;
const none = (): ContactChannelInfo => ({ status: "NOT_SET", via: null, at: null, expiresAt: null });
const NAME_MAX = 80;

export function createOnboardingApi(x: Ctx): OnboardingApi {
  const s = x.store;
  const iso = (ms = x.clock()) => new Date(ms).toISOString();
  const invalid = (field: string, message: string) => x.err(400, "VALIDATION_FAILED", message, { fields: [{ field, message }] });
  const notFound = () => x.err(404, "NOT_FOUND", "Not found.");
  const staffOnly = () => { if (x.portal) throw notFound(); };
  const customerById = (id: string): FxCustomer => { staffOnly(); const c = x.customers.find((k) => k.id === id); if (!c) throw notFound(); return c; };
  const statusOf = (id: string) => (id === "cus_eden" ? "SUSPENDED" : id === "cus_iruda" || id === "cus_kumho" ? "TERMINATED" : "ACTIVE") as CustomerRecord["status"];
  const record = (c: FxCustomer): CustomerRecord => s.created[c.id] ?? { id: c.id, name: c.name, slug: c.slug, status: statusOf(c.id), loginDomains: s.domains[c.id] ?? [], createdAt: "2026-10-01T00:00:00Z" };
  const activeCustomer = (id: string) => { const c = customerById(id); if (record(c).status === "TERMINATED") throw x.err(409, "CUSTOMER_TERMINATED", "A terminated customer cannot be changed."); return c; };
  const readName = (v: unknown): string => {
    const n = typeof v === "string" ? v.trim() : "";
    if (!n || n.length > NAME_MAX || /[\u0000-\u001f]/.test(n)) throw invalid("name", `name is required (1-${NAME_MAX} characters).`);
    return n;
  };
  const freeSlug = (base: string, taken: Set<string>) => { let slug = base, n = 2; while (taken.has(slug)) slug = `${base}-${n++}`; return slug; };

  function readDomains(v: unknown, selfId?: string): string[] {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.length > 10) throw invalid("loginDomains", "loginDomains must be a list of at most 10 domains.");
    const d = [...new Set(v.map((e) => (typeof e === "string" ? e.trim().toLowerCase() : "")))];
    if (d.some((e) => !DOMAIN_RE.test(e))) throw invalid("loginDomains", "Each login domain must look like example.com.");
    if (d.some(isFreeMail)) throw x.err(422, "VALIDATION_FAILED", "A public mail domain cannot be a login domain. Use the customer’s own company domain.", { fields: [{ field: "loginDomains", message: "Public mail domain." }] });
    for (const [cid, list] of Object.entries(s.domains)) if (cid !== selfId && list.some((e) => d.includes(e))) throw x.err(409, "ALREADY_EXISTS", "A login domain already belongs to another customer.", { field: "loginDomains" });
    return d;
  }

  // ---- accounts ----
  const suffix = (a: MockAccount) => a.awsAccountId.slice(-3);
  const view = (a: MockAccount): AccountRecord => {
    const r = structuredClone(a) as Partial<MockAccount>;
    for (const k of ["readyAt", "lastCommandAt", "roleStatus", "firstEventAt", "lastEventAt"] as const) delete r[k];
    return r as AccountRecord;
  };
  /** the engine's answer, written when its delay has passed */
  function settle(a: MockAccount) {
    if (a.readyAt === null || x.clock() < a.readyAt) return;
    const sfx = suffix(a);
    const optional: Record<string, boolean> = { alarmWriter: a.alarmWriterEnabled, tagWriter: a.tagWriterEnabled, remediator: a.remediatorEnabled };
    const st: AccountMock["roleStatus"] = {};
    const bad = sfx === "403" ? "DENIED" : sfx === "404" ? "MISSING" : null;
    st.reader = bad ?? "OK";
    for (const k of ["alarmWriter", "tagWriter", "remediator"] as const) if (optional[k]) st[k] = bad ?? (sfx === "402" && k === "alarmWriter" ? "DENIED" : "OK");
    a.roleStatus = st;
    if ((sfx === "401" || sfx === "402") && !a.firstEventAt) { a.firstEventAt = iso(a.readyAt); }
    if (sfx === "401" || sfx === "402") a.lastEventAt = iso(a.readyAt);
    a.lastCheckedAt = iso(a.readyAt);
    a.readyAt = null;
  }
  type AccountMock = MockAccount;
  const accountById = (id: string): MockAccount => {
    staffOnly();
    const a = s.accounts.find((k) => k.id === id);
    if (!a) throw notFound();
    return a;
  };
  const roleOf = (a: MockAccount, key: AccountRoleKey): AccountRoleStatus => {
    const required = key === "reader" || key === "eventForwarder";
    const enabled = required || (key === "alarmWriter" ? a.alarmWriterEnabled : key === "tagWriter" ? a.tagWriterEnabled : a.remediatorEnabled);
    const stored = a.roleStatus[key] ?? "UNKNOWN";
    const fromEvents = key === "eventForwarder" && stored === "UNKNOWN" && a.firstEventAt !== null;
    return { key, required, enabled, status: fromEvents ? "OK" : enabled ? stored : "UNKNOWN", basis: fromEvents ? "EVENTS" : "CHECK" };
  };

  // ---- contacts ----
  const needsAction = (c: MockContact) => (["EMAIL", "SMS"] as const).some((k) => c.channels[k].status === "UNVERIFIED" || c.channels[k].status === "EXPIRED" || c.channels[k].status === "LINK_SENT");
  const contactView = (c: MockContact): ContactRecord => {
    const rest = structuredClone(c) as Partial<MockContact>;
    for (const k of ["customerId", "email", "phone", "meta"] as const) delete rest[k];
    // a link that ran out is EXPIRED, as the list shows it
    const channels = structuredClone(c.channels);
    for (const k of Object.keys(channels) as ContactChannelKey[]) {
      const ch = channels[k];
      if (ch.status === "LINK_SENT" && ch.expiresAt && Date.parse(ch.expiresAt) < x.clock()) channels[k] = { ...ch, status: "EXPIRED" };
    }
    return { ...(rest as ContactRecord), channels, needsAction: needsAction({ ...c, channels }) };
  };
  const contactById = (id: string): MockContact => { staffOnly(); const c = s.contacts.find((k) => k.id === id); if (!c) throw notFound(); return c; };
  const sendLink = (c: MockContact, channel: VerifyChannel, bulk: boolean): "SENT" | "NOT_SET" | "UNAVAILABLE" => {
    const value = channel === "EMAIL" ? c.email : channel === "SMS" ? c.phone : undefined;
    if (!value) return "NOT_SET";
    if (channel === "SMS") return "UNAVAILABLE";
    if (!bulk) {
      const last = c.meta[channel]?.sentAt;
      if (last !== undefined && x.clock() - last < VERIFY_COOLDOWN_SEC * 1000) {
        const sec = Math.ceil((VERIFY_COOLDOWN_SEC * 1000 - (x.clock() - last)) / 1000);
        throw x.err(429, "RATE_LIMITED", "A link was sent a moment ago. Wait a minute before sending another.", { retryAfterSec: sec });
      }
    }
    const now = x.clock();
    c.meta[channel] = { sentAt: now };
    c.channels[channel] = { status: "LINK_SENT", via: "link", at: iso(now), expiresAt: iso(now + VERIFY_TTL_MS) };
    s.tokens[`vf_mock_${++s.seq}_${c.id}`] = { contactId: c.id, channel, used: false };
    return "SENT";
  };

  return {
    async createCustomer(b) {
      x.need("ADMIN"); staffOnly();
      const name = readName((b as { name?: unknown }).name);
      const dup = x.customers.find((c) => c.name.toLowerCase() === name.toLowerCase());
      if (dup) throw x.err(409, "ALREADY_EXISTS", "A customer with this name already exists.", { existingCustomerId: dup.id });
      const loginDomains = readDomains(b.loginDomains);
      const slug = freeSlug(slugify(name) || "customer", new Set(x.customers.map((c) => c.slug)));
      const c: FxCustomer = { id: `cus_${slug}`, slug, name, mine: false, callHealth: "OK", projects: [] };
      x.customers.push(c);
      x.paging.byCustomer[c.id] = { templateId: null, staff: [], people: [], config: null, configVersion: 0, respondersVersion: 0, removedPeople: {}, slackChannel: "NOT_SET", overrides: [], extraProblems: [] };
      s.domains[c.id] = loginDomains;
      const rec: CustomerRecord = { id: c.id, name, slug, status: "ACTIVE", loginDomains, createdAt: iso() };
      s.created[c.id] = rec;
      return structuredClone(rec);
    },
    async getCustomer(id) { return structuredClone(record(customerById(id))); },
    async listProjects(id) {
      const c = customerById(id);
      return c.projects.map((p): ProjectRecord => ({ id: p.id, customerId: c.id, name: p.name, slug: p.slug, serviceCount: p.services.length }));
    },
    async createProject(id, b) {
      x.need("ADMIN");
      const c = activeCustomer(id);
      const name = readName(b.name);
      if (c.projects.some((p) => p.name.toLowerCase() === name.toLowerCase())) throw x.err(409, "ALREADY_EXISTS", "A project with this name already exists.");
      const slug = freeSlug(slugify(name) || "project", new Set(c.projects.map((p) => p.slug)));
      const p: FxProject = { id: `prj_${c.slug}_${slug}`, slug, name, ownSteps: false, services: [] };
      c.projects.push(p);
      return { id: p.id, customerId: c.id, name, slug, serviceCount: 0 };
    },
    async listServices(projectId) {
      staffOnly();
      for (const c of x.customers) {
        const p = c.projects.find((k) => k.id === projectId);
        if (p) return p.services.map((v): ServiceRecord => ({ id: v.id, customerId: c.id, projectId: p.id, name: v.name, slug: v.slug }));
      }
      throw notFound();
    },
    async createService(projectId, b) {
      x.need("ADMIN");
      staffOnly();
      for (const c of x.customers) {
        const p = c.projects.find((k) => k.id === projectId);
        if (!p) continue;
        activeCustomer(c.id);
        const name = readName(b.name);
        if (p.services.some((v) => v.name.toLowerCase() === name.toLowerCase())) throw x.err(409, "ALREADY_EXISTS", "A service with this name already exists.");
        const slug = freeSlug(slugify(name) || "service", new Set(p.services.map((v) => v.slug)));
        const v = { id: `svc_${c.slug}_${p.slug}_${slug}`, slug, name, ownSteps: false };
        p.services.push(v);
        return { id: v.id, customerId: c.id, projectId: p.id, name, slug };
      }
      throw notFound();
    },

    async listAccounts(customerId) { x.need("ADMIN"); customerById(customerId); const list = s.accounts.filter((a) => a.customerId === customerId); list.forEach(settle); return list.map(view); },
    async createAccount(customerId, b) {
      x.need("ADMIN");
      const c = activeCustomer(customerId);
      const allowed = ["awsAccountId", "alias", "environment", "regions", "serviceId", "alarmWriterEnabled", "tagWriterEnabled", "remediatorEnabled"];
      const bad = Object.keys(b).filter((k) => !allowed.includes(k));
      if (bad.length) throw x.err(400, "VALIDATION_FAILED", "Not accepted here.", { fields: bad.map((field) => ({ field, message: /externalId|RoleArn/.test(field) ? "Generated by the server; it cannot be set." : "Not accepted here." })) });
      if (typeof b.awsAccountId !== "string" || !/^[0-9]{12}$/.test(b.awsAccountId)) throw invalid("awsAccountId", "awsAccountId must be exactly 12 digits (as text).");
      if (b.environment !== undefined && !["PRD", "STG", "DEV"].includes(b.environment)) throw invalid("environment", "environment must be PRD, STG, DEV or null.");
      if (b.alias !== undefined && b.alias.trim().length > 80) throw invalid("alias", "alias is text of at most 80 characters.");
      for (const k of ["alarmWriterEnabled", "tagWriterEnabled", "remediatorEnabled"] as const) if (b[k] !== undefined && typeof b[k] !== "boolean") throw invalid(k, `${k} must be true or false.`);
      if (s.accounts.some((a) => a.awsAccountId === b.awsAccountId)) throw x.err(409, "ALREADY_EXISTS", "This AWS account is already registered.");
      let serviceId: string | null = null;
      if (b.serviceId) {
        if (!c.projects.some((p) => p.services.some((v) => v.id === b.serviceId))) throw notFound();
        serviceId = b.serviceId;
      }
      const a: MockAccount = {
        id: `acc_${b.awsAccountId}`, customerId, serviceId, awsAccountId: b.awsAccountId, alias: b.alias?.trim() || null, environment: b.environment ?? null, regions: b.regions ?? ["ap-northeast-2"],
        externalId: externalIdFor(b.awsAccountId, s.accounts.length), alarmWriterEnabled: b.alarmWriterEnabled ?? false, tagWriterEnabled: b.tagWriterEnabled ?? false, remediatorEnabled: b.remediatorEnabled ?? false,
        stackVersion: null, disabled: false, lastCheckedAt: null, createdAt: iso(), readyAt: null, lastCommandAt: null, roleStatus: {}, firstEventAt: null, lastEventAt: null,
      };
      s.accounts.push(a);
      return view(a);
    },
    async patchAccount(accountId, b) {
      x.need("ADMIN");
      const a = accountById(accountId);
      const keys = Object.keys(b);
      const caps: (keyof AccountCapabilities)[] = ["alarmWriterEnabled", "tagWriterEnabled", "remediatorEnabled"];
      const bad = keys.filter((k) => !caps.includes(k as keyof AccountCapabilities));
      if (bad.length) throw x.err(400, "VALIDATION_FAILED", "Not accepted here.", { fields: bad.map((field) => ({ field, message: "Not accepted here." })) });
      for (const k of caps) if (b[k] !== undefined) { if (typeof b[k] !== "boolean") throw invalid(k, `${k} must be true or false.`); a[k] = b[k]!; }
      return view(a);
    },
    async checkAccount(accountId) {
      x.need("ADMIN");
      const a = accountById(accountId);
      if (suffix(a) === "503") throw x.err(503, "COMMANDS_UNAVAILABLE", "The command queue is not configured; the connection was not checked.");
      if (a.disabled) throw x.err(409, "ACCOUNT_DISABLED", "This account is disabled; its connection cannot be checked.");
      const now = x.clock();
      if (a.lastCommandAt !== null && now - a.lastCommandAt < CHECK_COOLDOWN_SEC * 1000) {
        throw x.err(429, "RATE_LIMITED", "A check for this account was queued a moment ago. Wait for its result.", { retryAfterSec: Math.ceil((CHECK_COOLDOWN_SEC * 1000 - (now - a.lastCommandAt)) / 1000) });
      }
      a.lastCommandAt = now;
      a.readyAt = now + ENGINE_DELAY_MS;
      return { commandId: `cmd_mock_${++s.seq}` };
    },
    async getAccountStatus(accountId) {
      const a = accountById(accountId);
      settle(a);
      const st: AccountStatus = {
        accountId: a.id, customerId: a.customerId, awsAccountId: a.awsAccountId, roles: ROLE_KEYS.map((k) => roleOf(a, k)),
        lastCheckedAt: a.lastCheckedAt, firstEventAt: a.firstEventAt, lastEventAt: a.lastEventAt, stackVersion: a.stackVersion, disabled: a.disabled,
      };
      return st;
    },

    async listContacts(q) {
      x.need("ADMIN");
      customerById(q.customerId);
      const items = s.contacts.filter((c) => c.customerId === q.customerId).map(contactView).filter((c) => !q.needsAction || c.needsAction).sort((a, b) => a.name.localeCompare(b.name));
      return { items, nextCursor: null };
    },
    async createContact(b) {
      x.need("ADMIN");
      activeCustomer(b.customerId);
      const name = readName(b.name);
      const email = b.email?.trim() || undefined;
      const phone = b.phone?.trim() || undefined;
      if (!email && !phone) throw x.err(400, "VALIDATION_FAILED", "An e-mail, a phone number or a Slack user is required.", { fields: [{ field: "email", message: "Give an e-mail or a phone number." }] });
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalid("email", "email must look like name@example.com.");
      if (phone && !/^\+?[0-9][0-9 -]{6,18}$/.test(phone)) throw invalid("phone", "phone must be a phone number such as 010-1234-5678.");
      const set = (v: boolean): ContactChannelInfo => (v ? { status: "UNVERIFIED" as ChannelState, via: null, at: null, expiresAt: null } : none());
      const c: MockContact = {
        id: `ct_new_${++s.seq}`, kind: "CUSTOMER", name, active: true, emailMasked: email ? maskEmail(email) : null, phoneMasked: phone ? maskPhone(phone) : null, hasSlack: false,
        channels: { EMAIL: set(Boolean(email)), SMS: set(Boolean(phone)), VOICE: set(Boolean(phone)), SLACK: none() }, needsAction: true, canReveal: false, revealRequiresReason: true,
        customerId: b.customerId, email, phone, meta: {},
      };
      s.contacts.push(c);
      return contactView(c);
    },
    async verifyContact(id, b) {
      x.need("ADMIN");
      const c = contactById(id);
      if (!["EMAIL", "SMS", "SLACK"].includes(b.channel)) throw invalid("channel", "channel must be EMAIL, SMS or SLACK.");
      if (b.method === "manual") {
        const ch = b.channel === "SLACK" ? "SLACK" : b.channel;
        if (c.channels[ch].status === "NOT_SET") throw x.err(422, "VALIDATION_FAILED", "That channel has no value to verify.", { fields: [{ field: "channel", message: "No value." }] });
        c.channels[ch] = { status: "VERIFIED", via: `admin:${x.me.name}`, at: iso(), expiresAt: null };
        if (ch === "SMS") c.channels.VOICE = { ...c.channels.SMS };
        return { verified: true, channel: b.channel, method: "manual" };
      }
      if (b.method !== "link" || b.channel === "SLACK") throw invalid("method", "method must be link (e-mail, SMS) or manual.");
      const r = sendLink(c, b.channel, false);
      if (r === "NOT_SET") throw x.err(422, "VALIDATION_FAILED", "That channel has no value to verify.", { fields: [{ field: "channel", message: "No value." }] });
      if (r === "UNAVAILABLE") throw x.err(503, "VERIFICATION_UNAVAILABLE", "Verification links cannot be sent yet.");
      return { status: "LINK_SENT", channel: b.channel, method: "link", expiresAt: c.channels[b.channel].expiresAt! };
    },
    async verifyBulk(ids) {
      x.need("ADMIN");
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > 200) throw invalid("contactIds", "contactIds must be a list of 1-200 ids.");
      const list = ids.map(contactById);
      let sent = 0, failed = 0;
      const notSet: { contactId: string; channel: VerifyChannel }[] = [];
      for (const c of list) {
        for (const ch of ["EMAIL", "SMS"] as const) {
          const st = c.channels[ch].status;
          if (st === "NOT_SET") { notSet.push({ contactId: c.id, channel: ch }); continue; }
          if (st === "VERIFIED") continue;
          const r = sendLink(c, ch, true);
          if (r === "SENT") sent++; else failed++;
        }
      }
      return { sent, notSet, throttled: 0, failed };
    },

    async peekVerify(token) {
      const t = s.tokens[token];
      if (!t || t.used) throw notFound();
      return { pending: true, channel: t.channel };
    },
    async confirmVerify(token) {
      const t = s.tokens[token];
      if (!t || t.used) throw notFound();
      t.used = true;
      const c = t.contactId ? s.contacts.find((k) => k.id === t.contactId) : undefined;
      if (c) { c.channels[t.channel as "EMAIL" | "SMS"] = { status: "VERIFIED", via: "link", at: iso(), expiresAt: null }; if (t.channel === "SMS") c.channels.VOICE = { ...c.channels.SMS }; }
      return { verified: true, channel: t.channel };
    },
  };
}
