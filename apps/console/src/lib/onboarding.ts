/**
 * Pure helpers of the customer onboarding screens (no server-only import: the pages and the unit tests share them).
 * Words and rules follow docs/ui/screens/customer-onboarding.md; where the API differs the API wins (see the issue report).
 */
import type { AccountCapabilities, AccountRecord, AccountRoleKey, AccountRoleStatus, AccountStatus, ChannelState, VerifyChannel } from "./api/types";
import { errorLine, type Failure } from "./errors";

/* ------------------------------------------------------------------------------------------------ login domains */
const DOMAIN_RE = /^(?=.{3,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
export const MAX_LOGIN_DOMAINS = 10;

/** "mirae.example, pay.mirae.example" → a clean list. Syntax and count only: public mail domains are refused by the API (422), which the page words. */
export function parseLoginDomains(text: string): { ok: true; domains: string[] } | { ok: false; message: string } {
  const parts = text.split(/[,;\n\r]+/).map((p) => p.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
  const domains = [...new Set(parts)];
  if (domains.length > MAX_LOGIN_DOMAINS) return { ok: false, message: `Use at most ${MAX_LOGIN_DOMAINS} login domains.` };
  const bad = domains.find((d) => !DOMAIN_RE.test(d));
  if (bad) return { ok: false, message: `“${bad.slice(0, 60)}” is not a domain. Each login domain looks like example.com; separate several with commas.` };
  return { ok: true, domains };
}

/* ------------------------------------------------------------------------------------------------ errors */
export type OnboardingWhat = "customer" | "project" | "service" | "account" | "check" | "contact" | "verify";
const field = (f: Failure): string => {
  const d = f.details ?? {};
  if (typeof d.field === "string") return d.field;
  const first = Array.isArray(d.fields) ? (d.fields[0] as { field?: unknown } | undefined) : undefined;
  return typeof first?.field === "string" ? first.field : "";
};

/** The line shown for a failed onboarding call. Says what was not done and what to change. */
export function onboardingError(f: Failure, what: OnboardingWhat, nowMs = Date.now()): string {
  const d = f.details ?? {};
  const retry = typeof d.retryAfterSec === "number" ? retryTime(nowMs, d.retryAfterSec) : null;
  switch (f.code) {
    case "VALIDATION_FAILED":
      if (field(f) === "loginDomains") return /public/i.test(f.message + JSON.stringify(d)) ? "A public mail domain (such as gmail.com or naver.com) cannot be a login domain. Use the customer’s own company domain." : "Check the login domains: each looks like example.com, at most 10.";
      if (field(f) === "awsAccountId") return "An AWS account id is exactly 12 digits.";
      if (field(f) === "name") return `Give the ${what === "contact" ? "person" : what} a name of 1 to 80 characters.`;
      if (field(f) === "email") return "That e-mail address does not look right. Use name@example.com.";
      if (field(f) === "phone") return "That phone number does not look right. Use digits, for example 010-1234-5678.";
      break;
    case "ALREADY_EXISTS":
      if (field(f) === "loginDomains") return "Another customer already uses one of these login domains. A domain can belong to one customer.";
      if (what === "customer") return "A customer with this name already exists.";
      if (what === "account") return "This AWS account is already registered. An account can belong to one customer only.";
      if (what === "project" || what === "service") return `A ${what} with this name already exists here. Choose another name.`;
      break;
    case "RATE_LIMITED":
      if (what === "check") return `A check for this account was queued a moment ago. You can check again ${retry ?? "in about 30 seconds"}.`;
      if (what === "verify") return `A link was sent a moment ago. You can send another ${retry ?? "in about a minute"}.`;
      break;
    case "COMMANDS_UNAVAILABLE": return "Connection checks are not available yet. Nothing was changed. Ask whoever manages the console’s deployment.";
    case "COMMAND_PUBLISH_FAILED": return "The check could not be queued. Try again in a moment.";
    case "ACCOUNT_DISABLED": return "This account is disabled, so its connection cannot be checked.";
    case "CUSTOMER_TERMINATED": return "This customer is terminated, so nothing can be added to it.";
    case "VERIFICATION_UNAVAILABLE": return "Links cannot be sent yet, because no sender is set up. Verify by hand instead (after you have checked the address or number with the person).";
    case "NOT_FOUND": return "Not found. It may have been removed, or you may not have access to it.";
    case "SEND_FAILED": return "The link could not be sent. Try again, or verify by hand.";
  }
  return errorLine(f);
}
/** "at 14:32 KST" — the time a cooldown ends, said as a clock time and not as a running count */
export function retryTime(nowMs: number, sec: number): string {
  const t = new Date(nowMs + Math.max(1, sec) * 1000 + 9 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `at ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())} KST`;
}

/* ------------------------------------------------------------------------------------------------ roles */
export const ROLE_ORDER: AccountRoleKey[] = ["reader", "eventForwarder", "alarmWriter", "tagWriter", "remediator"];
export const ROLE_NAME: Record<AccountRoleKey, string> = { reader: "Reader", eventForwarder: "EventForwarder", alarmWriter: "AlarmWriter", tagWriter: "TagWriter", remediator: "Remediator" };
/** What turning it on lets AlarmOps do (docs/ui/screens/customer-onboarding.md "역할 카드") */
export const ROLE_ABOUT: Record<AccountRoleKey, string> = {
  reader: "Find resources, read alarm states, read-only root-cause checks.",
  eventForwarder: "Send alarm state changes and tag changes to the central event bus.",
  alarmWriter: "Create alarms and change thresholds. Only alarms tagged ManagedBy=AlarmOps are touched.",
  tagWriter: "Let the console add the Monitoring tag (only that key; never S3 or Route 53).",
  remediator: "Stop EC2 or RDS and delete load balancers that carry Monitoring=on, only after a person approves in Slack.",
};
export const ROLE_OFF: Record<AccountRoleKey, string> = {
  reader: "", eventForwarder: "", alarmWriter: "Threshold editing stays off.", tagWriter: "Re-tag stays off; the customer adds the tag.", remediator: "Alarms only notify; nothing is stopped or deleted.",
};
export const CAP_KEY: Record<"alarmWriter" | "tagWriter" | "remediator", keyof AccountCapabilities> = { alarmWriter: "alarmWriterEnabled", tagWriter: "tagWriterEnabled", remediator: "remediatorEnabled" };
export const REMEDIATOR_WARNING = "Remediator can stop EC2 and RDS instances and delete load balancers that carry Monitoring=on. It acts only after a person approves in Slack (D-15). If TagWriter is also on, tags the console adds widen what it can act on. Keep it off for the pilot.";

export type RoleTone = "ok" | "fail" | "wait" | "off";
export interface RoleLine { key: AccountRoleKey; name: string; required: boolean; tone: RoleTone; label: string; next: string }

/** One row of the result table: state in words (not by colour alone) and the next step for a failure. */
export function roleLine(r: AccountRoleStatus, checked: boolean): RoleLine {
  const name = ROLE_NAME[r.key];
  const base = { key: r.key, name, required: r.required };
  if (!r.enabled) return { ...base, tone: "off", label: "Not enabled", next: "" };
  if (r.status === "OK") return { ...base, tone: "ok", label: r.basis === "EVENTS" ? "OK · events received" : "OK", next: "" };
  if (r.status === "DENIED") {
    return { ...base, tone: "fail", label: "Failed · access denied",
      next: r.key === "reader" ? "Trust policy rejects our role. Check that the ExternalId in the customer’s stack is exactly the one above, and that CentralRoleArn is the one from deploy-central."
        : `${name} was refused. Check that the stack was updated with Enable${name}=true and the same ExternalId.` };
  }
  if (r.status === "MISSING") {
    return { ...base, tone: "fail", label: "Failed · role not found",
      next: `The role AlarmOps-${name} does not exist in the customer’s account. Ask the customer to create or update the connection stack in ap-northeast-2${r.required ? "" : ` with Enable${name}=true`}.` };
  }
  if (r.key === "eventForwarder") {
    return { ...base, tone: "wait", label: checked ? "Waiting for the first event" : "Not checked yet",
      next: checked ? "This check cannot test EventForwarder. It turns OK when the first event arrives. If none comes: is the account on the bus allow-list, and is CentralEventBusArn right in the stack?" : "" };
  }
  return { ...base, tone: "wait", label: "Not checked yet", next: "" };
}
export const roleLines = (s: AccountStatus): RoleLine[] =>
  [...s.roles].sort((a, b) => ROLE_ORDER.indexOf(a.key) - ROLE_ORDER.indexOf(b.key)).map((r) => roleLine(r, s.lastCheckedAt !== null));

/** One summary for the customer page and the wizard: required roles all OK = connected. Nothing is "connected" before a check or an event. */
export type Connection = "CONNECTED" | "PARTIAL" | "FAILED" | "NOT_CHECKED";
export function connectionOf(s: AccountStatus | null): Connection {
  if (!s || s.disabled) return "NOT_CHECKED";
  const lines = roleLines(s);
  if (s.lastCheckedAt === null && s.firstEventAt === null) return "NOT_CHECKED";
  // a failing OPTIONAL role does not make the connection fail: AlarmOps is connected, that role is not working
  if (lines.some((l) => l.tone === "fail" && l.required)) return "FAILED";
  if (lines.filter((l) => l.required).every((l) => l.tone === "ok")) return "CONNECTED";
  return "PARTIAL";
}
/** The headline after a check: "Connected. 1 optional role is not working." rather than "Check failed." when only optional roles failed */
export function checkHeadline(s: AccountStatus): string {
  const c = connectionOf(s);
  const optFail = roleLines(s).filter((l) => l.tone === "fail" && !l.required).length;
  if (c === "CONNECTED" && optFail > 0) return `Connected. ${optFail} optional role${optFail === 1 ? " is" : "s are"} not working.`;
  return `${CONNECTION_LABEL[c]}.`;
}
export const CONNECTION_LABEL: Record<Connection, string> = { CONNECTED: "Connected", PARTIAL: "Waiting for events", FAILED: "Check failed", NOT_CHECKED: "Not checked yet" };

/* ------------------------------------------------------------------------------------------------ the connection kit */
export interface CentralValues { centralRoleArn: string | null; centralBusArn: string | null; remediatorCallerRoleArn: string | null }
/** Nothing configured: every central value is missing (the kit says so). Real values come from centralValues() (CENTRAL_ROLE_ARN, CENTRAL_EVENT_BUS_ARN, REMEDIATOR_CALLER_ROLE_ARN). */
export const NO_CENTRAL: CentralValues = { centralRoleArn: null, centralBusArn: null, remediatorCallerRoleArn: null };
export interface KitParam { name: string; value: string; placeholder: boolean; note: string }

/** Parameters of infra/customer-stack/template.yaml, in the order the customer fills them. */
export function kitParams(a: Pick<AccountRecord, "externalId" | "alarmWriterEnabled" | "tagWriterEnabled" | "remediatorEnabled">, c: CentralValues = NO_CENTRAL): KitParam[] {
  const out: KitParam[] = [
    { name: "CentralRoleArn", value: c.centralRoleArn ?? "<missing: ask whoever ran the central deployment (deploy-central) for CentralRoleArn>", placeholder: !c.centralRoleArn, note: "The one AlarmOps role the stack trusts." },
    { name: "ExternalId", value: a.externalId ?? "", placeholder: false, note: "Made for this connection. Give it to the customer only." },
    { name: "CentralEventBusArn", value: c.centralBusArn ?? "<missing: ask whoever ran the central deployment (deploy-central) for CentralBusArn>", placeholder: !c.centralBusArn, note: "Where the stack sends events (ap-northeast-2)." },
    { name: "EnableAlarmWriter", value: String(a.alarmWriterEnabled), placeholder: false, note: "" },
    { name: "EnableTagWriter", value: String(a.tagWriterEnabled), placeholder: false, note: "" },
    { name: "EnableRemediator", value: String(a.remediatorEnabled), placeholder: false, note: "" },
  ];
  if (a.remediatorEnabled) out.push({ name: "RemediatorCallerRoleArn", value: c.remediatorCallerRoleArn ?? "<missing: ask whoever ran the central deployment (deploy-central) for RemediatorCallerRoleArn>", placeholder: !c.remediatorCallerRoleArn, note: "Required when EnableRemediator is true: the separate role that runs approved actions." });
  return out;
}
/** How many values of the kit are still missing (placeholders). The kit is not to be sent while this is above 0. */
export const kitMissing = (p: KitParam[]): number => p.filter((x) => x.placeholder).length;
/** Where the central values come from, in plain words */
export const SOURCE_WORDS = "the outputs of the central deployment (deploy-central) — ask whoever ran it";
/** All parameters as `Name=value` lines, for one copy */
export const kitText = (p: KitParam[]): string => p.map((x) => `${x.name}=${x.value}`).join("\n");

/* ------------------------------------------------------------------------------------------------ contacts */
export const CHANNEL_NAME: Record<VerifyChannel, string> = { EMAIL: "E-mail", SMS: "SMS", SLACK: "Slack" };
export const CHANNEL_STATE: Record<ChannelState, { label: string; tone: RoleTone }> = {
  VERIFIED: { label: "Verified", tone: "ok" }, LINK_SENT: { label: "Link sent", tone: "wait" }, EXPIRED: { label: "Link expired", tone: "fail" },
  UNVERIFIED: { label: "Not verified", tone: "wait" }, NOT_SET: { label: "Not set", tone: "off" },
};
