/**
 * Settings › Users: the rules the screen shows before a click, and the words for what the API answers (API-CONTRACT
 * §8.4 "구현 메모 #69", D-55). The API stays the authority: these checks only keep the buttons honest and the messages
 * plain. No server-only imports: the page, the client component and the tests all use this file.
 */
import type { Role, UserItem, UserKind, UserStatus } from "./api/types";
import { errorLine, type Failure } from "./errors";

export const ROLE_LABEL: Record<Role, string> = { ADMIN: "Admin", OPERATOR: "Operator", VIEWER: "Viewer" };
export const ROLE_HELP: Record<Role, string> = {
  ADMIN: "Can change settings, call orders and users.",
  OPERATOR: "Can acknowledge, escalate and resolve incidents.",
  VIEWER: "Can only read.",
};
export const STATUS_LABEL: Record<UserStatus, string> = { ACTIVE: "Active", DISABLED: "Disabled", PENDING: "Pending" };
/** a shape next to the text: the status never relies on colour */
export const STATUS_MARK: Record<UserStatus, string> = { ACTIVE: "✓", DISABLED: "⊘", PENDING: "◔" };

export const NAME_MAX = 80;
const CONTROL = /[\u0000-\u001f\u007f]/;
/** the same address check the API makes (packages/api usersApi.ts), so a form never offers what the API will refuse */
const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?=.{3,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
export const normalizeEmail = (raw: string): string | null => { const e = raw.trim().toLowerCase(); return e.length <= 254 && EMAIL_RE.test(e) ? e : null; };
export const emailDomain = (email: string): string => email.slice(email.lastIndexOf("@") + 1);

/**
 * The staff sign-in fence the console knows from its configuration (`SSO_ALLOWED_DOMAINS`, plain, not a secret). The
 * exception list (`SSO_ALLOWED_EMAILS`) is not sent to the browser, so the screen can only say "outside the allowed
 * domains" and "unless the address is on the exception list".
 */
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const DOMAIN_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`);
export function staffFenceDomains(env: Record<string, string | undefined> = process.env): string[] {
  const out: string[] = [];
  for (const d of (env.SSO_ALLOWED_DOMAINS ?? "").split(",").map((s) => s.trim().toLowerCase())) if (d && d.length <= 253 && DOMAIN_RE.test(d) && !out.includes(d)) out.push(d);
  return out;
}
export const outsideFence = (email: string, domains: readonly string[]): boolean => domains.length > 0 && !domains.includes(emailDomain(email));

export interface NewUserDraft { kind: UserKind; email: string; name: string; role: Role | ""; customerId: string }
/** what blocks the Add button, in the order the form asks for it; empty = the API can accept it */
export function newUserProblems(d: NewUserDraft): { email?: string; name?: string; role?: string; customerId?: string } {
  const p: { email?: string; name?: string; role?: string; customerId?: string } = {};
  if (d.email.trim() === "") p.email = "Enter an e-mail address.";
  else if (!normalizeEmail(d.email)) p.email = "This does not look like an e-mail address. Use the address of the Google account, such as name@example.com.";
  const name = d.name.trim();
  if (!name) p.name = "Enter a name.";
  else if (name.length > NAME_MAX) p.name = `Use at most ${NAME_MAX} characters.`;
  else if (CONTROL.test(name)) p.name = "Use plain characters only.";
  if (d.kind === "INTERNAL" && !d.role) p.role = "Choose a role.";
  if (d.kind === "CUSTOMER" && !d.customerId) p.customerId = "Choose the customer this person belongs to.";
  return p;
}

export interface RowContext { meId: string; /** ACTIVE staff ADMINs with all customers, whatever the list filter shows */ activeAdmins: number }
export interface RowRules {
  /** reason a control is off, or null when it is offered */
  role: string | null; status: string | null; move: string | null; google: string | null;
  /** short, shown under the row when something is off */
  notes: string[];
}
const SELF = "You can't change your own role or status, or clear your own Google link. Ask another admin.";
const LAST = "This is the last active admin with access to all customers. Make another admin first.";

/** The rules of PATCH /users/{id} as the page can know them before the click. The API repeats every one of them. */
export function rowRules(u: UserItem, c: RowContext): RowRules {
  const self = u.id === c.meId;
  const lastAdmin = u.kind === "INTERNAL" && u.role === "ADMIN" && u.status === "ACTIVE" && c.activeAdmins <= 1;
  const rules: RowRules = { role: null, status: null, move: null, google: null, notes: [] };
  if (u.kind === "CUSTOMER") rules.role = "Portal users always have the read-only Viewer role.";
  else if (self) rules.role = SELF;
  else if (lastAdmin) rules.role = LAST;
  if (u.status === "ACTIVE" && self) rules.status = SELF;
  else if (u.status === "ACTIVE" && lastAdmin) rules.status = LAST;
  if (u.kind !== "CUSTOMER") rules.move = "Staff see every customer. Only a portal user belongs to one customer.";
  if (!u.googleBound) rules.google = "No Google account is linked yet: the first sign-in links one.";
  else if (self) rules.google = SELF;
  // the one-line explanation under the row: why something is off that the person might expect to work
  if (self) rules.notes.push(SELF);
  else if (lastAdmin) rules.notes.push(LAST);
  return rules;
}

export interface UserErrorContext { what: string; name?: string }
/**
 * Plain words for what the API refused, with the next step. Codes of this screen first (LAST_ADMIN, CONTACT_LINKED,
 * ALREADY_EXISTS, FORBIDDEN = your own account here), the shared wording for the rest.
 */
export function userErrorText(f: Failure, ctx: UserErrorContext): string {
  switch (f.code) {
    case "LAST_ADMIN": return `Nothing was changed. ${ctx.name ?? "This user"} is the last active admin with access to all customers. Make another user an admin first, then try again.`;
    case "CONTACT_LINKED": return `Nothing was changed. ${ctx.name ?? "This person"} is linked to a contact of the current customer, so they can't be moved. Unlink the contact first, or add a new portal user under the other customer.`;
    case "ALREADY_EXISTS": return "A user with this e-mail address already exists. Search for it in the list below: if it is disabled, enable it instead of adding it again.";
    case "FORBIDDEN": return "Nothing was changed. You can't change your own role or status, or clear your own Google link. Ask another admin to do it.";
    case "NOT_FOUND": return "This user was not found any more. Reload the list.";
    case "VALIDATION_FAILED": {
      const fields = Array.isArray(f.details?.fields) ? (f.details!.fields as { field?: unknown; message?: unknown }[]) : [];
      const first = fields[0];
      return first && typeof first.message === "string" && first.message ? `${first.message} Nothing was changed.` : "A value is not valid. Nothing was changed.";
    }
    default: return errorLine(f, { what: ctx.what });
  }
}
