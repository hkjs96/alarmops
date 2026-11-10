/**
 * Call order: the pure rules shared by the panel, the list and the mock API (D-30, D-32, D-20).
 *   - inheritance: service › project › customer, the first level with its own steps wins (never merged)
 *   - the sentence with real names, and its "before → after" form for the live preview
 *   - validation of an edit, paging health, the starting plans, the one-line diff used by the toast and the confirmation
 * Nothing here reads the network, the clock or storage.
 */
import type { ScopeCustomerNode } from "@alarmops/design-system";
import type {
  ChannelState, ContactChannelKey, CustomerPersonResponder, PagingConfigInput, PagingHealth, PagingPathStep, PagingPlan, PagingProblem,
  PagingStep, PagingStyle, RotationSummary, ScopeLevelName, StaffResponder, StaffSummary, StepChannel,
} from "../api/types";

/* ---------------- scope ---------------- */
export interface CoScope { customer: string; project?: string; service?: string }
export const scopeKey = (s: CoScope) => [s.customer, s.project, s.project ? s.service : undefined].filter(Boolean).join("/");
export function parseScopeKey(k: string): CoScope {
  const [customer = "", project, service] = k.split("/");
  return { customer, project: project || undefined, service: project ? service || undefined : undefined };
}
export const depthOf = (s: { project?: string; service?: string }) => (s.project ? (s.service ? 3 : 2) : 1);
export const levelOf = (s: { project?: string; service?: string }): ScopeLevelName => (["CUSTOMER", "PROJECT", "SERVICE"] as const)[depthOf(s) - 1]!;
export const callOrderPath = (s: CoScope) => `/c/${scopeKey(s)}/call-order`;

export interface ScopeNames { customer: string; project?: string; service?: string }
/** Names of a scope in the tree, or null when a slug does not resolve. */
export function namesOf(c: ScopeCustomerNode, s: CoScope): ScopeNames | null {
  if (c.slug !== s.customer) return null;
  const p = s.project ? c.projects.find((x) => x.slug === s.project) : undefined;
  if (s.project && !p) return null;
  const v = s.service ? p?.services.find((x) => x.slug === s.service) : undefined;
  if (s.service && !v) return null;
  return { customer: c.name, project: p?.name, service: v?.name };
}
export const pathOf = (n: ScopeNames) => [n.customer, n.project, n.service].filter((x): x is string => Boolean(x));
export const labelOf = (n: ScopeNames) => pathOf(n).join(" › ");

/** The level whose steps apply to `s`: the deepest level at or above it that has own steps. */
export function sourceOf(c: ScopeCustomerNode, s: CoScope): CoScope {
  const p = s.project ? c.projects.find((x) => x.slug === s.project) : undefined;
  const v = s.service ? p?.services.find((x) => x.slug === s.service) : undefined;
  if (v?.ownSteps) return { customer: c.slug, project: p!.slug, service: v.slug };
  if (p?.ownSteps) return { customer: c.slug, project: p.slug };
  return { customer: c.slug };
}

export interface Reach {
  /** services whose pages would follow the steps of this level: "Core › Payments API" */
  services: string[];
  /** levels below that keep their own steps: "Data platform", "Fulfilment › Orders API" */
  kept: string[];
}
/**
 * Which services the steps held at `s` page for. A service follows the deepest level above it that has own steps, so a
 * project or service with own steps below `s` is not reached. `s` is treated as having steps (it has, or is about to).
 */
export function reachOf(c: ScopeCustomerNode, s: CoScope): Reach {
  const d = depthOf(s);
  const services: string[] = [];
  const kept: string[] = [];
  for (const p of c.projects) {
    if (s.project && p.slug !== s.project) continue;
    for (const v of p.services) {
      if (s.service && v.slug !== s.service) continue;
      const origin = v.ownSteps ? 3 : p.ownSteps ? 2 : 1;
      if (origin <= d) services.push(`${p.name} › ${v.name}`);
      else {
        const n = origin === 3 ? `${p.name} › ${v.name}` : p.name;
        if (!kept.includes(n)) kept.push(n);
      }
    }
  }
  return { services, kept };
}
export const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
export function reachText(r: Reach): string {
  const kept = r.kept.length ? ` (${r.kept.join(", ")} keep${r.kept.length > 1 ? "" : "s"} own steps)` : "";
  return (r.services.length ? plural(r.services.length, "service") : "no service right now") + kept;
}

/** Stored configs of one customer → the one that applies. `overrides` are keyed by scopeType + scopeId. */
export function resolveStored<T extends { scopeType: ScopeLevelName; scopeId: string }>(customerCfg: T, overrides: readonly T[], ids: { projectId?: string; serviceId?: string }): T {
  const svc = ids.serviceId ? overrides.find((o) => o.scopeType === "SERVICE" && o.scopeId === ids.serviceId) : undefined;
  if (svc) return svc;
  const prj = ids.projectId ? overrides.find((o) => o.scopeType === "PROJECT" && o.scopeId === ids.projectId) : undefined;
  return prj ?? customerCfg;
}

/* ---------------- who a step reaches ---------------- */
export interface Directory {
  customerName: string;
  staff: StaffResponder[];
  people: CustomerPersonResponder[];
  rotations: RotationSummary[];
  /** every MSP staff member, for a step that names someone who is not a responder of this customer */
  allStaff?: StaffSummary[];
}
export const pageableIds = (d: Directory) => [...d.staff.map((s) => s.contactId), ...d.people.filter((p) => p.role === "PAGEABLE").map((p) => p.contactId)];
const contactOf = (d: Directory, id: string) => d.staff.find((s) => s.contactId === id) ?? d.people.find((p) => p.contactId === id);
export function nameOf(d: Directory, id: string): string {
  return contactOf(d, id)?.name ?? d.allStaff?.find((s) => s.contactId === id)?.name ?? d.rotations.find((r) => r.onShift?.contactId === id)?.onShift?.name ?? "Unknown person";
}
export const isCustomerPerson = (d: Directory, id: string) => d.people.some((p) => p.contactId === id);

/** The stored step plus who it reaches right now. The server does the same for GET /oncall/paging-path. */
export function resolveStep(step: PagingStep, d: Directory): PagingPathStep {
  if (step.targetType === "ALL_RESPONDERS") {
    const ids = pageableIds(d);
    return { ...step, targetId: undefined, nowIds: ids, names: ids.map((i) => nameOf(d, i)) };
  }
  if (step.targetType === "ROTATION") {
    const r = d.rotations.find((x) => x.id === step.targetId);
    return { ...step, nowIds: r?.onShift ? [r.onShift.contactId] : [], names: r?.onShift ? [r.onShift.name] : [], targetName: r?.name ?? "a rotation that no longer exists" };
  }
  const id = step.targetId ?? "";
  return { ...step, nowIds: id ? [id] : [], names: id ? [nameOf(d, id)] : [], targetName: id ? nameOf(d, id) : "nobody chosen", targetIsCustomerPerson: isCustomerPerson(d, id) };
}

/* ---------------- sentence ---------------- */
export interface Part { t: string; k?: "b" | "new" | "old" }
const CH_WORD: Record<StepChannel, string> = { SLACK_DM: "Slack", SMS: "SMS", VOICE: "call" };
const CH_ORDER: StepChannel[] = ["SLACK_DM", "SMS", "VOICE"];
export const CH_LABEL: Record<StepChannel, string> = { SLACK_DM: "Slack", SMS: "SMS", VOICE: "Call" };
export const sortChannels = (c: readonly StepChannel[]) => CH_ORDER.filter((x) => c.includes(x));
export function howText(channels: readonly StepChannel[], capital = true): string {
  const s = sortChannels(channels).map((c) => CH_WORD[c]).join(" + ") || "nothing";
  return capital ? s[0]!.toUpperCase() + s.slice(1) : s;
}
export const firstName = (n: string) => n.split(" ")[0] ?? n;
export function repeatText(n: number): string {
  return n <= 0 ? "no repeat" : n === 1 ? "repeat once" : n === 2 ? "repeat twice" : `repeat ${n} times`;
}
/** "on shift in MSP night desk (Haeun now)" · "Yuna Seo (Mirae Pay)" · "everyone in Responders (5)" */
export function targetParts(s: PagingPathStep, customerName: string): Part[] {
  if (s.targetType === "ALL_RESPONDERS") return [{ t: `everyone in Responders (${s.nowIds.length})` }];
  if (s.targetType === "ROTATION") {
    return [{ t: `on shift in ${s.targetName ?? "a rotation"} (` }, s.names[0] ? { t: firstName(s.names[0]), k: "b" } : { t: "nobody", k: "b" }, { t: " now)" }];
  }
  return [{ t: s.targetName ?? s.names[0] ?? "nobody chosen", k: "b" }, ...(s.targetIsCustomerPerson ? [{ t: ` (${customerName})` }] : [])];
}
export const partsText = (p: readonly Part[]) => p.filter((x) => x.k !== "old").map((x) => x.t).join("");
const targetKey = (s: PagingStep) => `${s.targetType}:${s.targetId ?? ""}`;
function stepParts(s: PagingPathStep, customerName: string, was?: PagingPathStep): Part[] {
  const out: Part[] = [];
  const how = howText(s.channels);
  if (was && howText(was.channels) !== how) out.push({ t: how, k: "new" }, { t: howText(was.channels), k: "old" });
  else out.push({ t: how });
  out.push({ t: " " });
  if (was && targetKey(was) !== targetKey(s)) out.push(...targetParts(s, customerName).map((p) => ({ ...p, k: "new" as const })), { t: partsText(targetParts(was, customerName)), k: "old" });
  else out.push(...targetParts(s, customerName));
  out.push({ t: " " });
  const at = (n: number) => (n > 0 ? `${n} min` : "now");
  if (was && was.atMin !== s.atMin) out.push(...(s.atMin > 0 ? [{ t: "at " }] : []), { t: at(s.atMin), k: "new" }, { t: at(was.atMin), k: "old" });
  else if (s.atMin > 0) out.push({ t: "at " }, { t: at(s.atMin), k: "b" });
  else out.push({ t: "now" });
  return out;
}
/**
 * "Slack + call on shift in MSP night desk (Haeun now) now → Call Yuna Seo (Mirae Pay) at 10 min → … → repeat once."
 * With `before`, whatever differs is marked `new` and followed by the old value marked `old` (shown struck through;
 * an old part carries no space of its own — the view sets it off).
 */
export function sentenceParts(steps: readonly PagingPathStep[], repeatCount: number, customerName: string, before?: { steps: readonly PagingPathStep[]; repeatCount: number }): Part[] {
  const out: Part[] = [];
  const arrow = () => { if (out.length) out.push({ t: " → " }); };
  steps.forEach((s, i) => {
    arrow();
    const was = before?.steps[i];
    const p = stepParts(s, customerName, was);
    out.push(...(before && !was ? [{ t: partsText(p), k: "new" as const }] : p));
  });
  before?.steps.slice(steps.length).forEach((s) => { arrow(); out.push({ t: partsText(stepParts(s, customerName)), k: "old" }); });
  arrow();
  if (before && before.repeatCount !== repeatCount) out.push({ t: repeatText(repeatCount), k: "new" }, { t: repeatText(before.repeatCount), k: "old" });
  else out.push({ t: repeatText(repeatCount) });
  out.push({ t: "." });
  return out;
}
export const sentenceText = (steps: readonly PagingPathStep[], repeatCount: number, customerName: string) => partsText(sentenceParts(steps, repeatCount, customerName));

/** Everyone the steps would page right now, in step order, once each. */
export function pagedNow(steps: readonly PagingPathStep[]): { id: string; name: string }[] {
  const seen = new Set<string>();
  const out: { id: string; name: string }[] = [];
  for (const s of steps) s.nowIds.forEach((id, n) => { if (!seen.has(id)) { seen.add(id); out.push({ id, name: s.names[n] ?? "Unknown person" }); } });
  return out;
}

/* ---------------- starting plans (DATA-MODEL EscalationStep: code constants) ---------------- */
export const STYLE_LABEL: Record<PagingStyle, string> = { ALL_AT_ONCE: "All at once", CUSTOMER_ROTATION: "Customer rotation", SHARED_ROTATION: "Shared rotation", CUSTOM: "Custom" };
export const PLAN_LABEL: Record<PagingPlan, string> = { STANDARD: "Standard", URGENT: "Urgent", QUIET: "Quiet" };
const PLAN: Record<PagingPlan, { at: number; all?: boolean; ch: StepChannel[] }[]> = {
  STANDARD: [{ at: 0, ch: ["SLACK_DM"] }, { at: 2, ch: ["SMS"] }, { at: 7, ch: ["VOICE"] }, { at: 12, all: true, ch: ["VOICE"] }],
  URGENT: [{ at: 0, ch: ["VOICE"] }, { at: 5, all: true, ch: ["VOICE"] }],
  QUIET: [{ at: 0, ch: ["SLACK_DM"] }, { at: 15, all: true, ch: ["SLACK_DM"] }],
};
type First = Pick<PagingStep, "targetType" | "targetId">;
/**
 * Steps of a starting plan. `first` is who is called first (the rotation on shift, a person, or everyone); the plan's
 * last step always goes to everyone. When everyone is first already (All at once) that last step is left out.
 */
export function planSteps(plan: PagingPlan, first: First): PagingStep[] {
  const everyone = first.targetType === "ALL_RESPONDERS";
  return PLAN[plan].filter((s) => !(everyone && s.all)).map((s) => ({
    atMin: s.at, channels: [...s.ch],
    ...(s.all || everyone ? { targetType: "ALL_RESPONDERS" as const } : { targetType: first.targetType, targetId: first.targetId }),
  }));
}
/** Who is first for an ordering style, or null when the style needs a rotation that is not chosen yet. */
export function firstOfStyle(style: PagingStyle, rotationId: string | undefined, current: readonly PagingStep[]): First | null {
  if (style === "ALL_AT_ONCE") return { targetType: "ALL_RESPONDERS" };
  if (style === "CUSTOM") return current[0] ? { targetType: current[0].targetType, targetId: current[0].targetId } : { targetType: "ALL_RESPONDERS" };
  return rotationId ? { targetType: "ROTATION", targetId: rotationId } : null;
}
export const sameSteps = (a: readonly PagingStep[], b: readonly PagingStep[]) =>
  a.length === b.length && a.every((s, i) => s.atMin === b[i]!.atMin && targetKey(s) === targetKey(b[i]!) && howText(s.channels) === howText(b[i]!.channels));
export const sameConfig = (a: PagingConfigInput, b: PagingConfigInput) =>
  a.style === b.style && a.plan === b.plan && (a.sharedRotationId ?? "") === (b.sharedRotationId ?? "") && a.repeatCount === b.repeatCount && sameSteps(a.steps, b.steps);
/** Unchanged plan steps → not "edited" (D-30: the plan is only a starting template). */
export function isEdited(cfg: PagingConfigInput): boolean {
  const first = cfg.steps[0];
  return !first || !sameSteps(cfg.steps, planSteps(cfg.plan, { targetType: first.targetType, targetId: first.targetId }));
}
export const MAX_REPEAT = 5;
export const MAX_MINUTE = 1440;

/* ---------------- reachability, validation, health (D-32) ---------------- */
const CH_KEY: Record<StepChannel, ContactChannelKey> = { SLACK_DM: "SLACK", SMS: "SMS", VOICE: "VOICE" };
const channelsOf = (d: Directory, id: string) =>
  contactOf(d, id)?.channels ?? d.rotations.find((r) => r.onShift?.contactId === id)?.onShift?.channels ?? d.allStaff?.find((s) => s.contactId === id)?.channels ?? {};
const stateOf = (d: Directory, id: string, ch: StepChannel): ChannelState => channelsOf(d, id)[CH_KEY[ch]] ?? "NOT_SET";
/** A contact is reached by a step when one of the step's channels is verified for them. */
export const reachable = (d: Directory, id: string, channels: readonly StepChannel[]) => channels.some((c) => stateOf(d, id, c) === "VERIFIED");

export interface Issue { stepIndex?: number; field?: "atMin" | "target" | "channels" | "repeat" | "style"; message: string }
export interface Validation { errors: Issue[]; warnings: Issue[] }

export function validateConfig(cfg: PagingConfigInput, d: Directory): Validation {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  if (cfg.steps.length === 0) errors.push({ message: "Add at least one step. Without steps nobody is called." });
  if (!Number.isInteger(cfg.repeatCount) || cfg.repeatCount < 0 || cfg.repeatCount > MAX_REPEAT) errors.push({ field: "repeat", message: `Repeat must be a whole number from 0 to ${MAX_REPEAT}.` });
  if ((cfg.style === "SHARED_ROTATION" || cfg.style === "CUSTOMER_ROTATION") && !cfg.steps.some((s) => s.targetType === "ROTATION")) {
    errors.push({ field: "style", message: `${STYLE_LABEL[cfg.style]} needs a rotation. Choose one, or pick another ordering.` });
  }
  cfg.steps.forEach((s, i) => {
    const n = i + 1;
    if (!Number.isInteger(s.atMin) || s.atMin < 0 || s.atMin > MAX_MINUTE) errors.push({ stepIndex: i, field: "atMin", message: `Step ${n}: minutes must be a whole number from 0 to ${MAX_MINUTE}.` });
    else if (i === 0 && s.atMin !== 0) errors.push({ stepIndex: 0, field: "atMin", message: "Step 1 starts at 0 min: the first call goes out when the incident opens." });
    else if (i > 0 && s.atMin <= cfg.steps[i - 1]!.atMin) {
      errors.push({ stepIndex: i, field: "atMin", message: `Step ${n} (${s.atMin} min) would not come after step ${i} (${cfg.steps[i - 1]!.atMin} min). Fix the minutes to save.` });
    }
    if (s.channels.length === 0) errors.push({ stepIndex: i, field: "channels", message: `Step ${n}: choose at least one of Slack, SMS or Call.` });
    if (s.targetType === "PERSON" && !s.targetId) errors.push({ stepIndex: i, field: "target", message: `Step ${n}: choose a person.` });
    else if (s.targetType === "PERSON" && d.people.some((p) => p.contactId === s.targetId && p.role !== "PAGEABLE")) {
      errors.push({ stepIndex: i, field: "target", message: `Step ${n}: ${nameOf(d, s.targetId!)} is Notify only and cannot be called. Make them Pageable in Responders first.` });
    }
    if (s.targetType === "ROTATION" && !d.rotations.some((r) => r.id === s.targetId)) errors.push({ stepIndex: i, field: "target", message: `Step ${n}: choose a rotation.` });
  });
  if (errors.length) return { errors, warnings };
  const res = cfg.steps.map((s) => resolveStep(s, d));
  const ok = res.map((s) => s.nowIds.some((id) => reachable(d, id, s.channels)));
  if (!ok.some(Boolean)) {
    errors.push({ message: pageableIds(d).length === 0 && res.every((s) => s.nowIds.length === 0)
      ? "Nobody would be called: no step reaches a person right now. Name a person or a rotation, or add someone to Responders."
      : "Nobody would be reached: no step has a person with a verified Slack, SMS or phone for the way it calls." });
    return { errors, warnings };
  }
  res.forEach((s, i) => {
    if (ok[i]) return;
    warnings.push({ stepIndex: i, field: "target", message: s.nowIds.length === 0
      ? `Step ${i + 1} reaches nobody right now.`
      : `Step ${i + 1} reaches only contacts that are not verified for ${howText(s.channels, false)}: ${s.names.join(", ")}.` });
  });
  return { errors, warnings };
}

/** D-32. UNREACHABLE: no step reaches a verified contact. AT_RISK: some step depends on unverified contacts only. */
export function computeHealth(steps: readonly PagingStep[], d: Directory, extra: readonly PagingProblem[] = []): PagingHealth {
  const problems: PagingProblem[] = [];
  const res = steps.map((s) => resolveStep(s, d));
  const ok = res.map((s) => s.nowIds.some((id) => reachable(d, id, s.channels)));
  if (pageableIds(d).length === 0 && !ok.some(Boolean)) {
    problems.push({ code: "NO_PAGEABLE_RESPONDER", contactIds: [], message: "Nobody in Responders can be called or texted. Add a staff member or a Pageable customer person." });
    return { level: "UNREACHABLE", problems };
  }
  if (!ok.some(Boolean)) {
    problems.push({ code: "NO_VERIFIED_PHONE", contactIds: [...new Set(res.flatMap((s) => s.nowIds))], message: "No step reaches a verified contact. Everyone the steps name still has to confirm their Slack, SMS or phone." });
    return { level: "UNREACHABLE", problems };
  }
  res.forEach((s, i) => {
    if (ok[i]) return;
    problems.push({ code: "STEP_UNVERIFIED_ONLY", stepIndex: i, contactIds: s.nowIds, message: s.nowIds.length === 0
      ? `Step ${i + 1} reaches nobody right now.`
      : `Step ${i + 1} (${howText(s.channels, false)}${s.atMin ? ` at ${s.atMin} min` : ", first"}) reaches only ${s.names.join(", ")}, who ${s.names.length > 1 ? "have" : "has"} no verified ${howText(s.channels, false)}.` });
  });
  problems.push(...extra);
  return { level: problems.length ? "AT_RISK" : "OK", problems };
}

/* ---------------- what an edit changes, in words ---------------- */
/** "step 2 10 → 8 min", "step 3 added", "repeat once → no repeat". Empty when nothing changed. */
export function diffConfig(before: PagingConfigInput, after: PagingConfigInput, target: (s: PagingStep) => string): string[] {
  const out: string[] = [];
  if (before.style !== after.style) out.push(`ordering ${STYLE_LABEL[before.style]} → ${STYLE_LABEL[after.style]}`);
  const n = Math.max(before.steps.length, after.steps.length);
  for (let i = 0; i < n; i++) {
    const [a, b] = [before.steps[i], after.steps[i]];
    if (a && !b) out.push(`step ${i + 1} removed`);
    else if (!a && b) out.push(`step ${i + 1} added (${howText(b.channels, false)} ${target(b)} at ${b.atMin} min)`);
    else if (a && b) {
      if (a.atMin !== b.atMin) out.push(`step ${i + 1} ${a.atMin} → ${b.atMin} min`);
      if (targetKey(a) !== targetKey(b)) out.push(`step ${i + 1} ${target(a)} → ${target(b)}`);
      if (howText(a.channels) !== howText(b.channels)) out.push(`step ${i + 1} ${howText(a.channels, false)} → ${howText(b.channels, false)}`);
    }
  }
  if (before.repeatCount !== after.repeatCount) out.push(`${repeatText(before.repeatCount)} → ${repeatText(after.repeatCount)}`);
  return out;
}

/* ---------------- step list edits ---------------- */
export function addStep(steps: readonly PagingStep[]): PagingStep[] {
  const last = steps[steps.length - 1];
  return [...steps, { atMin: last ? last.atMin + 5 : 0, targetType: "ALL_RESPONDERS", channels: ["VOICE"] }];
}
export const removeStep = (steps: readonly PagingStep[], i: number): PagingStep[] => {
  const out = steps.filter((_, n) => n !== i);
  return out.map((s, n) => (n === 0 ? { ...s, atMin: 0 } : s));
};
/** Moves who is called and how; the minute marks stay on their rows, so the times stay in order. */
export function moveStep(steps: readonly PagingStep[], i: number, dir: -1 | 1): PagingStep[] {
  const j = i + dir;
  if (j < 0 || j >= steps.length) return [...steps];
  const out = steps.map((s) => ({ ...s }));
  const [a, b] = [out[i]!, out[j]!];
  out[i] = { ...b, atMin: a.atMin };
  out[j] = { ...a, atMin: b.atMin };
  return out;
}
export const toInput = (c: PagingConfigInput): PagingConfigInput => ({
  style: c.style, plan: c.plan, ...(c.sharedRotationId ? { sharedRotationId: c.sharedRotationId } : {}), repeatCount: c.repeatCount,
  steps: c.steps.map((s) => ({ atMin: s.atMin, targetType: s.targetType, ...(s.targetType !== "ALL_RESPONDERS" && s.targetId ? { targetId: s.targetId } : {}), channels: sortChannels(s.channels) })),
});
