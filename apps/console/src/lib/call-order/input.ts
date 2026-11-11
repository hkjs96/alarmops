/**
 * Server action input checks for call-order saves (security review C-5, 권고 4·5): a server action accepts anything a
 * client sends, so everything the editor refuses is refused here again — shape, the contract's limits, minutes in
 * order, channels once each, and (with the customer's directory) a target that exists and somebody who is reached.
 * Messages are written for the user: they name the step and say what to change.
 */
import type { AddResponderInput, CustomerPersonRole, PagingConfigInput, PagingStep, StepChannel } from "../api/types";
import { InvalidInputError, isId, isSlug } from "../validate";
import { MAX_CHANNELS, MAX_MINUTE, MAX_REPEAT, MAX_STEPS } from "./limits";
import { isStepChannel, toInput, validateConfig, type CoScope, type Directory } from "./model";

const STYLES = ["ALL_AT_ONCE", "CUSTOMER_ROTATION", "SHARED_ROTATION", "CUSTOM"];
const PLANS = ["STANDARD", "URGENT", "QUIET"];
const bad = (what: string) => new InvalidInputError(`Invalid ${what}.`);
const say = (message: string) => new InvalidInputError(message);

export function assertScope(v: unknown): CoScope {
  const o = (v ?? {}) as Record<string, unknown>;
  if (!isSlug(o.customer)) throw bad("customer");
  if (o.project !== undefined && !isSlug(o.project)) throw bad("project");
  if (o.service !== undefined && (!isSlug(o.service) || o.project === undefined)) throw bad("service");
  return { customer: o.customer, project: o.project as string | undefined, service: o.service as string | undefined };
}

export function assertPagingInput(v: unknown): PagingConfigInput {
  const o = (v ?? {}) as Record<string, unknown>;
  if (!STYLES.includes(o.style as string)) throw bad("style");
  if (!PLANS.includes(o.plan as string)) throw bad("plan");
  if (o.sharedRotationId !== undefined && !isId(o.sharedRotationId)) throw bad("sharedRotationId");
  if (typeof o.repeatCount !== "number" || !Number.isInteger(o.repeatCount) || o.repeatCount < 0 || o.repeatCount > MAX_REPEAT) throw say(`Repeat must be a whole number from 0 to ${MAX_REPEAT}.`);
  if (!Array.isArray(o.steps) || o.steps.length === 0) throw say("Add at least one step. Without steps nobody is called.");
  if (o.steps.length > MAX_STEPS) throw say(`A call order has at most ${MAX_STEPS} steps; this one has ${o.steps.length}. Remove ${o.steps.length - MAX_STEPS} to save.`);
  let prev = -1;
  const steps: PagingStep[] = o.steps.map((x: unknown, i: number) => {
    const s = (x ?? {}) as Record<string, unknown>;
    const n = i + 1;
    if (typeof s.atMin !== "number" || !Number.isInteger(s.atMin) || s.atMin < 0 || s.atMin > MAX_MINUTE) throw say(`Step ${n}: minutes must be a whole number from 0 to ${MAX_MINUTE}.`);
    if (i === 0 && s.atMin !== 0) throw say("Step 1 starts at 0 min: the first call goes out when the incident opens.");
    if (i > 0 && s.atMin <= prev) throw say(`Step ${n} (${s.atMin} min) would not come after step ${i} (${prev} min). Fix the minutes to save.`);
    prev = s.atMin;
    if (s.targetType !== "PERSON" && s.targetType !== "ROTATION" && s.targetType !== "ALL_RESPONDERS") throw say(`Step ${n}: choose who it calls.`);
    if (s.targetType !== "ALL_RESPONDERS" && !isId(s.targetId)) throw say(`Step ${n}: choose ${s.targetType === "PERSON" ? "a person" : "a rotation"}.`);
    // each way to send once, nothing unknown, never a list of thousands
    if (!Array.isArray(s.channels) || s.channels.length === 0) throw say(`Step ${n}: choose at least one way to send it — Slack, Slack DM, SMS, Call or Email.`);
    if (s.channels.length > MAX_CHANNELS || !s.channels.every(isStepChannel) || new Set(s.channels).size !== s.channels.length) throw say(`Step ${n}: each way to send (Slack, Slack DM, SMS, Call, Email) can be chosen once.`);
    return { atMin: s.atMin, targetType: s.targetType, targetId: s.targetType === "ALL_RESPONDERS" ? undefined : (s.targetId as string), channels: s.channels as StepChannel[] };
  });
  return toInput({ style: o.style as PagingConfigInput["style"], plan: o.plan as PagingConfigInput["plan"], sharedRotationId: o.sharedRotationId as string | undefined, repeatCount: o.repeatCount, steps });
}

/**
 * The editor's own rules against the customer as it is now (lib/call-order/model validateConfig): the person or
 * rotation of every step exists for this customer, nobody Notify only is called, the send limits hold, and at least
 * one step reaches somebody. Throws the first problem in the editor's words.
 */
export function assertReachable(input: PagingConfigInput, dir: Directory): void {
  const { errors } = validateConfig(input, dir);
  if (errors.length) throw say(errors[0]!.message);
}

export function assertRole(v: unknown): CustomerPersonRole {
  if (v !== "PAGEABLE" && v !== "NOTIFY_ONLY") throw bad("role");
  return v;
}
/** control characters (line breaks included), and the characters that switch text direction: never in a name that ends up in Slack, mail or SMS */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
/** one "@", something on both sides, a dot in the domain, no spaces — the server decides the rest */
export const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
/** digits with an optional leading "+", spaces and hyphens between groups; 7 to 15 digits (E.164 length) */
export const PHONE_RE = /^\+?[0-9](?:[ -]?[0-9]){6,14}$/;
const text = (v: unknown, max: number) => (typeof v === "string" && v.trim().length > 0 && v.trim().length <= max ? v.trim() : undefined);

export function assertAddResponder(v: unknown): AddResponderInput {
  const o = (v ?? {}) as Record<string, unknown>;
  if (o.contactId !== undefined) {
    if (!isId(o.contactId)) throw bad("contactId");
    return { contactId: o.contactId, ...(o.role !== undefined ? { role: assertRole(o.role) } : {}) };
  }
  const name = text(o.name, 80);
  if (!name) throw say("Enter the person's name (up to 80 characters).");
  if (CONTROL.test(name)) throw say("The name has a character that cannot be used (a line break or a control character). Type the name again.");
  const blank = (x: unknown) => x === undefined || x === null || (typeof x === "string" && x.trim() === "");
  if (!blank(o.email) && typeof o.email !== "string") throw say("That email address does not look right. Example: name@company.com");
  if (!blank(o.phone) && typeof o.phone !== "string") throw say("That phone number does not look right. Use digits, optionally starting with +: +82 10-1234-5678");
  const email = blank(o.email) ? undefined : (o.email as string).trim();
  const phone = blank(o.phone) ? undefined : (o.phone as string).trim();
  if (!email && !phone) throw say("Enter an email or a phone number.");
  if (email && (email.length > 254 || !EMAIL_RE.test(email))) throw say("That email address does not look right. Example: name@company.com");
  if (phone && (phone.length > 32 || !PHONE_RE.test(phone))) throw say("That phone number does not look right. Use digits, optionally starting with +: +82 10-1234-5678");
  return { name, email, phone, role: assertRole(o.role) };
}
