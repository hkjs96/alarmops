"use server";
import { revalidatePath } from "next/cache";
import { getApi } from "@/lib/api";
import { requireSession } from "@/lib/auth";
import { requireRole } from "@/lib/auth/role";
import { assertBulkAction, assertBulkItems, assertId, assertToken, assertVersion } from "@/lib/validate";
import type { BulkItem, BulkPreview, BulkResult, UndoResult } from "@/lib/api/types";
import { fail, type ActionResult } from "@/lib/action-result";

export type { ActionResult };

/**
 * Session check first, then the role, then input validation, then the API call (security review C-2, C-5).
 * Everything here acknowledges, escalates, resolves or undoes that: Operator or Admin (security 재검토 권고 2). The
 * console's check is a second line; the API checks the role on the write itself and stays the authority.
 */
async function run<T>(fn: () => Promise<T>, revalidate = true): Promise<ActionResult<T>> {
  try {
    await requireSession();
    await requireRole("OPERATOR");
    const data = await fn();
    if (revalidate) revalidatePath("/", "layout"); // the list lives at /incidents and beside every /c/… panel
    return { ok: true, data };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Acknowledge one incident — the row, the card and the panel all use this. The version the user saw goes as If-Match,
 * so an Acknowledge pressed on a stale list does not land on an incident that re-fired or escalated meanwhile
 * (409 VERSION_CONFLICT, security R-3). Returns the undo token.
 */
export async function ackIncident(id: string, version: number): Promise<ActionResult<{ undoToken: string }>> {
  return run(async () => {
    const [i, v] = [assertId(id), assertVersion(version)];
    const r = await (await getApi()).ack(i, v);
    return { undoToken: r.undoToken };
  });
}
export async function resolveIncident(id: string, version: number) {
  return run(async () => {
    const [i, v] = [assertId(id), assertVersion(version)];
    await (await getApi()).resolve(i, v, {});
    return null;
  });
}
export async function escalateIncident(id: string, version: number) {
  return run(async () => {
    const [i, v] = [assertId(id), assertVersion(version)];
    await (await getApi()).escalate(i, v);
    return null;
  });
}
export async function previewBulk(action: "ack" | "resolve", items: BulkItem[]): Promise<ActionResult<BulkPreview>> {
  return run(async () => {
    const [a, list] = [assertBulkAction(action), assertBulkItems(items)];
    return (await getApi()).bulkPreview(a, list);
  }, false);
}
export async function executeBulk(action: "ack" | "resolve", items: BulkItem[]): Promise<ActionResult<BulkResult>> {
  return run(async () => {
    const [a, list] = [assertBulkAction(action), assertBulkItems(items)];
    return (await getApi()).bulkExecute(a, list);
  });
}
/** `restored` / `skipped`: an incident someone touched since is not put back (VERSION_CONFLICT) and the caller says so. */
export async function undoBulk(token: string): Promise<ActionResult<UndoResult>> {
  return run(async () => {
    const t = assertToken(token);
    const r = await (await getApi()).bulkUndo(t);
    return { restored: r.restored ?? [], skipped: r.skipped ?? [] };
  });
}
