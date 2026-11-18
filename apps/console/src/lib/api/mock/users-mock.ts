/**
 * Mock of API-CONTRACT 8.4 "구현 메모 #69": GET/POST /users, PATCH /users/{id} (D-55), with the contract's rules so the
 * console and its e2e can cover them without the backend:
 *   - ADMIN with all customers only (other staff 403, a portal user 404); e-mail only masked ("h•••@msp.example")
 *   - POST: staff = INTERNAL + role, portal user = CUSTOMER + exactly one customer (always VIEWER); duplicate e-mail
 *     (case-insensitive) 409 ALREADY_EXISTS; unknown keys and bad values 400 VALIDATION_FAILED
 *   - PATCH: role | status ACTIVE|DISABLED | customerId (portal only) | clearGoogleSub (true only); the same value is a
 *     200 without a write; 403 FORBIDDEN for your own role / status / Google link; 409 LAST_ADMIN (the last ACTIVE
 *     all-customer ADMIN cannot be demoted or disabled); 409 CONTACT_LINKED (a portal user with a linked contact cannot
 *     move to another customer)
 * Fixture people: Haeun (the default admin, the one you are signed in as), Junho (a second admin), Minjae, Sora, Dana
 * (disabled), and portal users Yuna (Mirae Pay, linked to a contact), Jiho (Daon Retail), Mina (Hanbit, pending).
 */
import { ApiError } from "../client";
import type { NewUserInput, Role, UserItem, UserListQuery, UserPatchInput } from "../types";
import type { FxCustomer } from "./scope-fixtures";

interface Row extends UserItem { email: string; contactLinked: boolean }
export interface UsersStore { rows: Row[]; seq: number }

const row = (id: string, name: string, email: string, kind: Row["kind"], role: Role, status: Row["status"], extra: Partial<Row> = {}): Row => ({
  id, name, email, kind, customerId: null, role, status, emailMasked: mask(email), googleBound: false, lastLoginAt: null, createdAt: "2026-10-01T00:00:00Z", contactLinked: false, ...extra,
});
const mask = (e: string) => `${e[0]!.toLowerCase()}•••@${e.split("@").pop()}`;

export function createUsersStore(): UsersStore {
  return {
    seq: 0,
    rows: [
      row("usr_haeun", "Haeun Kim", "haeun@msp.example", "INTERNAL", "ADMIN", "ACTIVE", { googleBound: true, lastLoginAt: "2026-11-18T00:30:00Z" }),
      row("usr_junho", "Junho Park", "junho@msp.example", "INTERNAL", "ADMIN", "ACTIVE", { googleBound: true, lastLoginAt: "2026-11-17T08:10:00Z" }),
      row("usr_minjae", "Minjae Lee", "minjae@msp.example", "INTERNAL", "OPERATOR", "ACTIVE", { googleBound: true, lastLoginAt: "2026-11-18T01:05:00Z" }),
      row("usr_sora", "Sora Yoon", "sora@msp.example", "INTERNAL", "VIEWER", "ACTIVE"),
      row("usr_dana", "Dana Choi", "dana@msp.example", "INTERNAL", "OPERATOR", "DISABLED", { googleBound: true, lastLoginAt: "2026-09-02T05:00:00Z" }),
      row("usr_portal", "Yuna Seo", "yuna@mirae.example", "CUSTOMER", "VIEWER", "ACTIVE", { customerId: "cus_mirae", googleBound: true, lastLoginAt: "2026-11-16T03:00:00Z", contactLinked: true }),
      row("usr_jiho", "Jiho Han", "jiho@daon.example", "CUSTOMER", "VIEWER", "ACTIVE", { customerId: "cus_daon", lastLoginAt: "2026-11-10T03:00:00Z" }),
      row("usr_mina", "Mina Oh", "mina@hanbit.example", "CUSTOMER", "VIEWER", "PENDING", { customerId: "cus_hanbit" }),
    ],
  };
}

const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?=.{3,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const ROLES: readonly string[] = ["VIEWER", "OPERATOR", "ADMIN"];
const view = (r: Row): UserItem => ({
  id: r.id, name: r.name, kind: r.kind, customerId: r.customerId, role: r.kind === "CUSTOMER" ? "VIEWER" : r.role, status: r.status,
  emailMasked: r.emailMasked, googleBound: r.googleBound, lastLoginAt: r.lastLoginAt, createdAt: r.createdAt,
});

export function createUsersApi(deps: {
  store: UsersStore; customers: FxCustomer[]; terminated: () => Set<string>;
  me: { id: string; role: Role; kind?: "INTERNAL" | "CUSTOMER" }; now: () => string; err: (status: number, code: string, message: string, details?: Record<string, unknown>) => ApiError;
}) {
  const { store, me, err } = deps;
  const invalid = (field: string, message: string) => err(400, "VALIDATION_FAILED", "Validation failed.", { fields: [{ field, message }] });
  /** portal 404, other staff 403 ROLE_REQUIRED (the mock user has no narrower ADMIN) */
  const adminAll = () => {
    if (me.kind === "CUSTOMER") throw err(404, "NOT_FOUND", "Not found.");
    if (me.role !== "ADMIN") throw err(403, "ROLE_REQUIRED", "This action needs the ADMIN role.", { role: "ADMIN" });
  };
  const liveCustomer = (id: string) => deps.customers.some((c) => c.id === id) && !deps.terminated().has(id);
  const activeAdmins = () => store.rows.filter((r) => r.kind === "INTERNAL" && r.role === "ADMIN" && r.status === "ACTIVE");

  return {
    async listUsers(q: UserListQuery = {}): Promise<{ items: UserItem[] }> {
      adminAll();
      if (q.kind && q.kind !== "INTERNAL" && q.kind !== "CUSTOMER") throw invalid("kind", "kind is INTERNAL or CUSTOMER.");
      if (q.status && !["PENDING", "ACTIVE", "DISABLED"].includes(q.status)) throw invalid("status", "Unknown status.");
      if (q.role && !ROLES.includes(q.role)) throw invalid("role", "Unknown role.");
      if (q.q && q.q.length > 100) throw invalid("q", "q is at most 100 characters.");
      const text = q.q?.trim().toLowerCase();
      const items = store.rows
        .filter((r) => (!q.kind || r.kind === q.kind) && (!q.customerId || r.customerId === q.customerId) && (!q.status || r.status === q.status)
          && (!q.role || view(r).role === q.role) && (!text || r.name.toLowerCase().includes(text) || r.email.includes(text)))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { items: structuredClone(items.map(view)) };
    },

    async createUser(b: NewUserInput): Promise<UserItem> {
      adminAll();
      const body = b as unknown as Record<string, unknown>;
      const unknown = Object.keys(body).filter((k) => !["email", "name", "kind", "role", "customerId"].includes(k) && body[k] !== undefined);
      if (unknown.length) throw err(400, "VALIDATION_FAILED", "Validation failed.", { fields: unknown.map((field) => ({ field, message: "Not accepted here." })) });
      const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
      if (!email || email.length > 254 || !EMAIL_RE.test(email)) throw invalid("email", "email must be a valid address.");
      const name = typeof b.name === "string" ? b.name.trim() : "";
      if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw invalid("name", "name is required (1-80 characters).");
      if (b.kind !== "INTERNAL" && b.kind !== "CUSTOMER") throw invalid("kind", "kind is INTERNAL or CUSTOMER.");
      let role: Role = "VIEWER";
      let customerId: string | null = null;
      if (b.kind === "INTERNAL") {
        if (!ROLES.includes(b.role as string)) throw invalid("role", "role is ADMIN, OPERATOR or VIEWER.");
        if (b.customerId !== undefined && b.customerId !== null) throw invalid("customerId", "MSP staff see all customers; a customer range cannot be set.");
        role = b.role as Role;
      } else {
        if (b.role !== undefined && b.role !== "VIEWER") throw invalid("role", "Portal users are always VIEWER.");
        if (typeof b.customerId !== "string" || !b.customerId) throw invalid("customerId", "A portal user belongs to exactly one customer: customerId is required.");
        customerId = b.customerId;
      }
      if (store.rows.some((r) => r.email === email)) throw err(409, "ALREADY_EXISTS", "A user with this e-mail already exists.");
      if (customerId && !liveCustomer(customerId)) throw invalid("customerId", "No such customer.");
      const r = row(`usr_new${++store.seq}`, name, email, b.kind, role, "ACTIVE", { customerId, createdAt: deps.now() });
      store.rows.push(r);
      return structuredClone(view(r));
    },

    async patchUser(id: string, b: UserPatchInput): Promise<UserItem> {
      adminAll();
      const cur = store.rows.find((r) => r.id === id);
      if (!cur) throw err(404, "NOT_FOUND", "Not found.");
      const body = b as unknown as Record<string, unknown>;
      const keys = Object.keys(body).filter((k) => body[k] !== undefined);
      const unknown = keys.filter((k) => !["role", "status", "customerId", "clearGoogleSub"].includes(k));
      if (unknown.length) throw err(400, "VALIDATION_FAILED", "Validation failed.", { fields: unknown.map((field) => ({ field, message: "Not accepted here." })) });
      if (keys.length === 0) throw invalid("body", "Nothing to change.");
      const patch: UserPatchInput = {};
      if ("role" in body) {
        if (!ROLES.includes(body.role as string)) throw invalid("role", "role is ADMIN, OPERATOR or VIEWER.");
        if (cur.kind === "CUSTOMER" && body.role !== "VIEWER") throw invalid("role", "Portal users are always VIEWER.");
        if (body.role !== cur.role) patch.role = body.role as Role;
      }
      if ("status" in body) {
        if (body.status !== "ACTIVE" && body.status !== "DISABLED") throw invalid("status", "status is ACTIVE (activate) or DISABLED.");
        if (body.status !== cur.status) patch.status = body.status;
      }
      if ("customerId" in body) {
        if (cur.kind !== "CUSTOMER") throw invalid("customerId", "MSP staff see all customers; a customer range cannot be set.");
        if (typeof body.customerId !== "string" || !body.customerId) throw invalid("customerId", "customerId must be a customer id.");
        if (body.customerId !== cur.customerId) patch.customerId = body.customerId;
      }
      if ("clearGoogleSub" in body) {
        if (body.clearGoogleSub !== true) throw invalid("clearGoogleSub", "clearGoogleSub can only be true.");
        if (cur.googleBound) patch.clearGoogleSub = true;
      }
      if (cur.id === me.id && (patch.role !== undefined || patch.status === "DISABLED" || patch.clearGoogleSub)) {
        throw err(403, "FORBIDDEN", "You cannot change your own role or status, or reset your own Google account.");
      }
      if (Object.keys(patch).length === 0) return structuredClone(view(cur));
      const losesAdmin = cur.kind === "INTERNAL" && cur.role === "ADMIN" && cur.status === "ACTIVE" && (patch.role !== undefined && patch.role !== "ADMIN" || patch.status === "DISABLED");
      if (losesAdmin && activeAdmins().filter((r) => r.id !== cur.id).length === 0) {
        throw err(409, "LAST_ADMIN", "This is the last active ADMIN with access to all customers. Make another ADMIN first.");
      }
      if (patch.customerId) {
        if (!liveCustomer(patch.customerId)) throw invalid("customerId", "No such customer.");
        if (cur.contactLinked) throw err(409, "CONTACT_LINKED", "This portal user is linked to a contact of the current customer; it cannot move to another customer.");
      }
      if (patch.role) cur.role = patch.role;
      if (patch.status) cur.status = patch.status;
      if (patch.customerId) cur.customerId = patch.customerId;
      if (patch.clearGoogleSub) cur.googleBound = false;
      return structuredClone(view(cur));
    },
  };
}
