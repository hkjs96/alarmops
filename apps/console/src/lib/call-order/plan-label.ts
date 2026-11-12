/**
 * The one wording for "which ordering and which starting plan": "Custom, started from Urgent (edited)".
 * Call order (Comes from, the editor) and the incident panel (the frozen snapshot) both use it — QA P2-A was the two
 * screens naming the same steps differently. The incident's snapshot carries the server's string (`planLabel`,
 * "Custom steps · Urgent (edited)") and, when the server sends them, the structured fields; both are read here.
 */
import type { AssignmentSnapshot, PagingPlan, PagingStyle } from "../api/types";

export const STYLE_LABEL: Record<PagingStyle, string> = { ALL_AT_ONCE: "All at once", CUSTOMER_ROTATION: "Customer rotation", SHARED_ROTATION: "Shared rotation", CUSTOM: "Custom" };
export const PLAN_LABEL: Record<PagingPlan, string> = { STANDARD: "Standard", URGENT: "Urgent", QUIET: "Quiet" };

export interface PlanRef { style: PagingStyle; plan: PagingPlan; edited: boolean }
export const planLabel = (p: PlanRef): string => `${STYLE_LABEL[p.style]}, started from ${PLAN_LABEL[p.plan]}${p.edited ? " (edited)" : ""}`;

/** the server's style words (packages/core escalation.ts) and the console's own */
const STYLE_WORDS: Record<string, PagingStyle> = {
  "all at once": "ALL_AT_ONCE", "customer rotation": "CUSTOMER_ROTATION", "shared msp rotation": "SHARED_ROTATION", "shared rotation": "SHARED_ROTATION",
  "custom steps": "CUSTOM", custom: "CUSTOM",
};
const PLAN_WORDS: Record<string, PagingPlan> = { standard: "STANDARD", urgent: "URGENT", quiet: "QUIET" };

/** "Custom steps · Urgent (edited)" → { CUSTOM, URGENT, edited }. null when it is not that shape. */
export function parsePlanLabel(text: string): PlanRef | null {
  const m = /^\s*(.+?)\s*(?:·|,\s*started from)\s*(\w+)\s*(\(edited\))?\s*$/i.exec(text);
  if (!m) return null;
  const style = STYLE_WORDS[m[1]!.toLowerCase()];
  const plan = PLAN_WORDS[m[2]!.toLowerCase()];
  return style && plan ? { style, plan, edited: Boolean(m[3]) } : null;
}

/** The label of an incident's frozen call order, in the console's one wording. Unknown wording is shown as the server sent it. */
export function snapshotPlanLabel(snap: Pick<AssignmentSnapshot, "planLabel"> | null | undefined): string | null {
  if (!snap) return null;
  if (!snap.planLabel) return null;
  const p = parsePlanLabel(snap.planLabel);
  return p ? planLabel(p) : snap.planLabel;
}
