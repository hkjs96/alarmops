/**
 * Responder templates: the words and the rules the two screens share (Call order › Templates, and the template field of
 * the customer's Responders). Pure: no API, no React. Spec: docs/ui/screens/oncall-templates.md. Contract: API-CONTRACT §8.3.
 */
import { MAX_ALL_RESPONDERS } from "./call-order/limits";
import { errorText, type ErrorContext, type Failure } from "./errors";
import type { TemplateBlocking, TemplateBlockReason, TemplateEffect, TemplatePreview } from "./api/types";

export const NAME_MAX = 80;
export const MEMBERS_MAX = 50;

/** One line of "what happens to this customer": a mark that is not a colour (+ − = !) and the words. */
export interface EffectLine { kind: TemplateEffect["kind"]; mark: "+" | "−" | "=" | "!"; /** the part before the dash that is shown bold (STEP_NAMES), else "" */ strong: string; text: string }

export function effectLine(e: TemplateEffect): EffectLine {
  switch (e.kind) {
    case "JOINS": return { kind: e.kind, mark: "+", strong: "", text: `${e.name} joins Responders` };
    case "LEAVES": return { kind: e.kind, mark: "−", strong: "", text: `${e.name} leaves Responders` };
    case "STAYS_DIRECT": return { kind: e.kind, mark: "=", strong: "", text: `${e.name} stays (added directly)` };
    case "ALREADY_DIRECT": return { kind: e.kind, mark: "=", strong: "", text: `${e.name} is already in Responders (added directly) — no change` };
    case "STEP_NAMES": return { kind: e.kind, mark: "!", strong: `step ${e.stepIndex ?? "?"} still names ${e.name}`, text: " — fix in the customer" };
  }
}
/** the whole line as one string: "+ Dohyun Kang joins Responders" */
export const effectString = (e: TemplateEffect): string => { const l = effectLine(e); return `${l.mark} ${l.strong}${l.text}`; };

export function blockingText(reason: TemplateBlockReason, customer: string): string {
  switch (reason) {
    case "UNREACHABLE": return `${customer}: nobody could be called after this change.`;
    case "RESPONDER_LIMIT_EXCEEDED": return `${customer}: a step that calls everyone in Responders would reach more than ${MAX_ALL_RESPONDERS} people.`;
    case "SEND_CAP_EXCEEDED": return `${customer}: a call order would send more notifications per incident than the limit allows.`;
  }
}
export const BLOCK_FIX = "Change the people, or fix those customers’ call orders first. There is no way around this.";
export const blockingTitle = (n: number): string => `Can’t save: this would break ${n === 1 ? "1 customer" : `${n} customers`}`;

export interface BlockedCustomer { customerId: string; name: string; reasons: TemplateBlockReason[] }
/** the blocking list of a preview, grouped by customer, in the order of the list */
export function blockedCustomers(blocking: readonly TemplateBlocking[], nameOf: (id: string) => string): BlockedCustomer[] {
  const out: BlockedCustomer[] = [];
  for (const b of blocking) {
    const hit = out.find((o) => o.customerId === b.customerId);
    if (hit) { if (!hit.reasons.includes(b.reason)) hit.reasons.push(b.reason); } else out.push({ customerId: b.customerId, name: nameOf(b.customerId), reasons: [b.reason] });
  }
  return out;
}

export const customersText = (n: number): string => (n === 1 ? "1 customer" : `${n} customers`);
export const saveLabel = (n: number): string => (n === 0 ? "Save template" : `Save template for ${customersText(n)}`);
/** "This change affects 7 customers" */
export const affectsText = (n: number): string => `This change affects ${customersText(n)}`;

export interface Draft { name: string; members: string[] }
export const sameMembers = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((m) => b.includes(m));
/** the draft against the saved template: changed or not (members as a set) */
export const isChanged = (saved: Draft, d: Draft): boolean => d.name.trim() !== saved.name || !sameMembers(saved.members, d.members);
/** what a preview or a save is asked: only what differs */
export function proposalOf(saved: Draft, d: Draft): { name?: string; members?: string[] } {
  return { ...(d.name.trim() !== saved.name ? { name: d.name.trim() } : {}), ...(!sameMembers(saved.members, d.members) ? { members: [...d.members] } : {}) };
}
/** the key of a draft: a preview belongs to exactly one */
export const draftKey = (d: Draft): string => JSON.stringify([d.name.trim(), [...d.members].sort()]);

export function draftProblems(d: Draft): { name?: string; members?: string } {
  const out: { name?: string; members?: string } = {};
  const n = d.name.trim();
  if (!n) out.name = "Enter a name.";
  else if (n.length > NAME_MAX) out.name = `Use at most ${NAME_MAX} characters.`;
  if (d.members.length < 1) out.members = "Add at least one person.";
  else if (d.members.length > MEMBERS_MAX) out.members = `A template has at most ${MEMBERS_MAX} people.`;
  return out;
}

export type PreviewState =
  | { status: "idle" }
  | { status: "loading"; key: string }
  | { status: "ready"; key: string; preview: TemplatePreview }
  | { status: "error"; key: string; message: string };

export interface SaveGate { enabled: boolean; /** why it is off, in words; null when on */ reason: string | null }
/**
 * Save is on only for a changed, valid draft whose preview is the preview of THIS draft, without anything blocking. Every other
 * state says why it is off, so the button is never dead without a reason.
 */
export function saveGate(args: { admin: boolean; roleWhy: string; saved: Draft; draft: Draft; preview: PreviewState; busy: boolean }): SaveGate {
  const { admin, roleWhy, saved, draft, preview, busy } = args;
  if (!admin) return { enabled: false, reason: roleWhy };
  if (busy) return { enabled: false, reason: "Saving…" };
  if (!isChanged(saved, draft)) return { enabled: false, reason: "Nothing has changed yet." };
  const p = draftProblems(draft);
  const problem = p.name ?? p.members;
  if (problem) return { enabled: false, reason: problem };
  if (preview.status === "loading") return { enabled: false, reason: "Checking what this change does…" };
  if (preview.status === "error") return { enabled: false, reason: "The effect could not be checked. Try again." };
  if (preview.status !== "ready" || preview.key !== draftKey(draft)) return { enabled: false, reason: "Checking what this change does…" };
  if (preview.preview.blocking.length) return { enabled: false, reason: "Blocked: see the customers marked below." };
  return { enabled: true, reason: null };
}

/** The sentence for a failed template action: the shared words (lib/errors.ts) plus the cases that only exist here. */
export function templateErrorText(f: Failure, ctx: ErrorContext & { name?: string } = {}): string {
  switch (f.code) {
    case "ALREADY_EXISTS": return `Not saved. A template named “${ctx.name ?? "that name"}” already exists. Nothing was changed. Choose a different name.`;
    case "CUSTOMER_TERMINATED": return `Not changed. ${ctx.where ?? "This customer"} is terminated and keeps its data as it is. Nothing was changed.`;
    case "NOT_FOUND": return "Not found. The template or the customer may have been removed. Reload the page.";
    case "VERSION_CONFLICT": return "Not saved. Someone else changed this in the meantime. Nothing was changed. Reload to see it as it is now, then make your change again.";
    default: return errorText(f, ctx);
  }
}
/** the failures that mean "what you looked at is out of date": the screen offers Reload / Preview again */
export const isOutOfDate = (code: string): boolean => code === "VERSION_CONFLICT" || code === "PREVIEW_STALE";
