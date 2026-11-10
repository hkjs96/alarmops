/**
 * Unsaved call-order edits, one per scope (shell-scope §6, API-CONTRACT §8.8): browser sessionStorage, key = screen +
 * scope path, tab only. A draft belongs to the scope it was made in and is never applied to another one. It holds ids,
 * minutes and channel kinds — no names of contacts beyond the scope label, no addresses, no phone numbers.
 */
import type { PagingConfigInput, PagingStep, PagingStyle, PagingPlan, StepChannel } from "../api/types";

export const DRAFT_PREFIX = "ao-draft:call-order:";
export interface CallOrderDraft {
  v: 1;
  /** "<customer>/<project>/<service>" slugs */
  scope: string;
  /** full path with names, customer first, for "Draft for … · Resume" */
  label: string;
  /** version of the steps when the edit started; null = creating own steps (nothing to match yet) */
  baseVersion: number | null;
  creating: boolean;
  /** the row that was open when the edit was widened to this level */
  widenedFrom?: string;
  value: PagingConfigInput;
  at: number;
}
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
function store(): Store | null {
  try { return typeof window === "undefined" ? null : window.sessionStorage; } catch { return null; }
}

const STYLES: PagingStyle[] = ["ALL_AT_ONCE", "CUSTOMER_ROTATION", "SHARED_ROTATION", "CUSTOM"];
const PLANS: PagingPlan[] = ["STANDARD", "URGENT", "QUIET"];
const CHANNELS: StepChannel[] = ["SLACK_DM", "SMS", "VOICE"];
const SCOPE_RE = /^[a-z0-9][a-z0-9-]{0,63}(\/[a-z0-9][a-z0-9-]{0,63}){0,2}$/;
function okStep(s: unknown): s is PagingStep {
  const o = s as PagingStep;
  return !!o && typeof o === "object" && typeof o.atMin === "number" && ["PERSON", "ROTATION", "ALL_RESPONDERS"].includes(o.targetType)
    && (o.targetId === undefined || typeof o.targetId === "string") && Array.isArray(o.channels) && o.channels.every((c) => CHANNELS.includes(c));
}
/** Storage is outside the app's control: anything that is not exactly a draft is treated as no draft. */
export function parseDraft(raw: string | null, scope?: string): CallOrderDraft | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as CallOrderDraft;
    const v = d?.value;
    if (d.v !== 1 || typeof d.scope !== "string" || !SCOPE_RE.test(d.scope) || (scope !== undefined && d.scope !== scope)) return null;
    if (typeof d.label !== "string" || typeof d.creating !== "boolean" || !(d.baseVersion === null || Number.isSafeInteger(d.baseVersion))) return null;
    if (d.widenedFrom !== undefined && !(typeof d.widenedFrom === "string" && SCOPE_RE.test(d.widenedFrom))) return null;
    if (!v || !STYLES.includes(v.style) || !PLANS.includes(v.plan) || typeof v.repeatCount !== "number" || !Array.isArray(v.steps) || !v.steps.every(okStep)) return null;
    if (v.sharedRotationId !== undefined && typeof v.sharedRotationId !== "string") return null;
    return d;
  } catch {
    return null;
  }
}

export function loadDraft(scope: string, s: Store | null = store()): CallOrderDraft | null {
  try { return parseDraft(s?.getItem(DRAFT_PREFIX + scope) ?? null, scope); } catch { return null; }
}
/** false when the browser refused (private mode, full): the edit then lives only as long as the panel is open */
export function saveDraft(d: Omit<CallOrderDraft, "v" | "at">, now: number, s: Store | null = store()): boolean {
  try {
    if (!s) return false;
    s.setItem(DRAFT_PREFIX + d.scope, JSON.stringify({ ...d, v: 1, at: now } satisfies CallOrderDraft));
    return true;
  } catch {
    return false;
  }
}
export function clearDraft(scope: string, s: Store | null = store()): void {
  try { s?.removeItem(DRAFT_PREFIX + scope); } catch { /* nothing to clear */ }
}
/** Every kept draft, newest first. */
export function listDrafts(s: Store | null = store()): CallOrderDraft[] {
  const out: CallOrderDraft[] = [];
  try {
    if (!s) return out;
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (!k?.startsWith(DRAFT_PREFIX)) continue;
      const d = parseDraft(s.getItem(k), k.slice(DRAFT_PREFIX.length));
      if (d) out.push(d);
    }
  } catch { /* unreadable storage: no drafts */ }
  return out.sort((a, b) => b.at - a.at);
}

/** Tells the list (same tab) that drafts changed; sessionStorage has no event of its own inside the tab. */
export const DRAFTS_EVENT = "ao-call-order-drafts";
export function announceDrafts(): void {
  try { window.dispatchEvent(new Event(DRAFTS_EVENT)); } catch { /* not in a browser */ }
}
