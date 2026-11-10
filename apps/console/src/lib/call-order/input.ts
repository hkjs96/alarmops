/** Server action input checks for call-order saves (security review C-5): a server action accepts anything a client sends. */
import type { AddResponderInput, CustomerPersonRole, PagingConfigInput, PagingStep, StepChannel } from "../api/types";
import { InvalidInputError, isId, isSlug } from "../validate";
import { MAX_MINUTE, MAX_REPEAT, toInput, type CoScope } from "./model";

const STYLES = ["ALL_AT_ONCE", "CUSTOMER_ROTATION", "SHARED_ROTATION", "CUSTOM"];
const PLANS = ["STANDARD", "URGENT", "QUIET"];
const CHANNELS: StepChannel[] = ["SLACK_DM", "SMS", "VOICE"];
const bad = (what: string) => new InvalidInputError(`Invalid ${what}.`);

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
  if (typeof o.repeatCount !== "number" || !Number.isInteger(o.repeatCount) || o.repeatCount < 0 || o.repeatCount > MAX_REPEAT) throw bad("repeatCount");
  if (!Array.isArray(o.steps) || o.steps.length === 0 || o.steps.length > 20) throw bad("steps");
  const steps: PagingStep[] = o.steps.map((x: unknown, i: number) => {
    const s = (x ?? {}) as Record<string, unknown>;
    if (typeof s.atMin !== "number" || !Number.isInteger(s.atMin) || s.atMin < 0 || s.atMin > MAX_MINUTE) throw bad(`steps[${i}].atMin`);
    if (s.targetType !== "PERSON" && s.targetType !== "ROTATION" && s.targetType !== "ALL_RESPONDERS") throw bad(`steps[${i}].targetType`);
    if (s.targetType !== "ALL_RESPONDERS" && !isId(s.targetId)) throw bad(`steps[${i}].targetId`);
    if (!Array.isArray(s.channels) || s.channels.length === 0 || !s.channels.every((c) => CHANNELS.includes(c as StepChannel))) throw bad(`steps[${i}].channels`);
    return { atMin: s.atMin, targetType: s.targetType, targetId: s.targetType === "ALL_RESPONDERS" ? undefined : (s.targetId as string), channels: s.channels as StepChannel[] };
  });
  return toInput({ style: o.style as PagingConfigInput["style"], plan: o.plan as PagingConfigInput["plan"], sharedRotationId: o.sharedRotationId as string | undefined, repeatCount: o.repeatCount, steps });
}

export function assertRole(v: unknown): CustomerPersonRole {
  if (v !== "PAGEABLE" && v !== "NOTIFY_ONLY") throw bad("role");
  return v;
}
const text = (v: unknown, max: number) => (typeof v === "string" && v.trim().length > 0 && v.length <= max ? v.trim() : undefined);
export function assertAddResponder(v: unknown): AddResponderInput {
  const o = (v ?? {}) as Record<string, unknown>;
  if (o.contactId !== undefined) {
    if (!isId(o.contactId)) throw bad("contactId");
    return { contactId: o.contactId, ...(o.role !== undefined ? { role: assertRole(o.role) } : {}) };
  }
  const name = text(o.name, 80);
  if (!name) throw bad("name");
  const email = text(o.email, 254);
  const phone = text(o.phone, 32);
  if (!email && !phone) throw new InvalidInputError("An email or a phone number is required.");
  return { name, email, phone, role: assertRole(o.role) };
}
