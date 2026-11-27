/**
 * e2e-only fixture variants of the mock. `E2E_FIXTURE=blocked-saves` (set by playwright.config.ts for its own second server, never by
 * the default one) adds what the default data cannot reach from the screen: a template change that the server refuses.
 * The default fixture is not touched, so its numbers (digest, counts, lists) stay as they are.
 *
 * Quill Labs (`/c/quill/call-order`): everyone is paged at once. Its Responders are the "Verified desk" template (Haeun Kim, all
 * channels verified) plus Pending Staff, added directly, who has verified nothing.
 *  - Detach "Verified desk": nobody verified is left, and the customer was reachable before -> 409 WOULD_BE_UNREACHABLE.
 *  - Switch to "Desk with leavers" (Haeun Kim + two deactivated staff): saves, and tells who was skipped. Changes the customer: run it last.
 *  - Switch to "Wide bench" (21 verified people): "everyone" would be 22 people -> 422 RESPONDER_LIMIT_EXCEEDED (D-38).
 */
import type { FxCustomer } from "./scope-fixtures";
import type { FxContact, FxPaging } from "./paging-fixtures";
import { planSteps } from "../../call-order/model";

export const BLOCKED_SAVES = "blocked-saves";
export const WIDE_BENCH_SIZE = 21;

export function fixtureVariant(): string | null {
  return process.env.E2E_FIXTURE === BLOCKED_SAVES ? BLOCKED_SAVES : null;
}

const VERIFIED = { SLACK: "VERIFIED", EMAIL: "VERIFIED", SMS: "VERIFIED", VOICE: "VERIFIED" } as const;
const UNVERIFIED = { SLACK: "UNVERIFIED", EMAIL: "UNVERIFIED", SMS: "UNVERIFIED", VOICE: "UNVERIFIED" } as const;

export function applyBlockedSavesFixture(customers: FxCustomer[], paging: FxPaging): void {
  const id = "cus_quill";
  customers.push({ id, slug: "quill", name: "Quill Labs", mine: false, callHealth: "OK", projects: [{ id: "prj_quill_main", slug: "main", name: "Main", ownSteps: false, services: [{ id: "svc_quill_main_web", slug: "web", name: "Web", ownSteps: false }] }] });
  const staff = (cid: string, name: string, channels: FxContact["channels"]): void => { paging.contacts[cid] = { id: cid, kind: "STAFF", name, title: "Cloud engineer", channels: { ...channels } }; };
  staff("ct_pending", "Pending Staff", UNVERIFIED);
  const wide: string[] = [];
  for (let n = 1; n <= WIDE_BENCH_SIZE; n++) {
    const cid = `ct_wide_${String(n).padStart(2, "0")}`;
    staff(cid, `Bench Person ${String(n).padStart(2, "0")}`, VERIFIED);
    wide.push(cid);
  }
  paging.templates.quill_ok = { name: "Verified desk", members: ["ct_haeun"], version: 1, updatedAt: "2026-11-04T05:00:00Z", updatedByName: "Junho Park" };
  paging.templates.quill_wide = { name: "Wide bench", members: wide, version: 1, updatedAt: "2026-11-04T05:00:00Z", updatedByName: "Junho Park" };
  // two deactivated staff in a template: switching to it skips them (11/27)
  for (const [cid, name] of [["ct_gone_b", "Birch Inactive"], ["ct_gone_a", "Alder Inactive"]] as const) { staff(cid, name, VERIFIED); paging.contacts[cid]!.active = false; }
  paging.templates.quill_leavers = { name: "Desk with leavers", members: ["ct_haeun", "ct_gone_b", "ct_gone_a"], version: 1, updatedAt: "2026-11-04T05:00:00Z", updatedByName: "Junho Park" };
  paging.byCustomer[id] = {
    templateId: "quill_ok", staff: ["ct_pending"], people: [],
    config: { id: `pc_${id}`, scopeType: "CUSTOMER", scopeId: id, style: "ALL_AT_ONCE", plan: "STANDARD", repeatCount: 1, steps: planSteps("STANDARD", { targetType: "ALL_RESPONDERS" }), version: 1, updatedByName: null, updatedAt: null },
    overrides: [], configVersion: 1, respondersVersion: 1, removedPeople: {}, slackChannel: "NOT_SET", extraProblems: [],
  };
}
