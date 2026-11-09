"use server";
import { revalidatePath } from "next/cache";
import { getApi } from "@/lib/api";
import { ApiError } from "@/lib/api/client";
import { requireSession, UnauthorizedError } from "@/lib/auth";
import { NotConfiguredError } from "@/lib/mode";
import { assertBulkAction, assertId, assertIds, assertToken, assertVersion, InvalidInputError } from "@/lib/validate";
import type { BulkPreview, BulkResult } from "@/lib/api/types";

export type ActionResult<T = null> = { ok: true; data: T } | { ok: false; code: string; message: string; requestId: string };

function fail(e: unknown): { ok: false; code: string; message: string; requestId: string } {
  if (e instanceof ApiError) return { ok: false, code: e.code, message: e.message, requestId: e.requestId };
  if (e instanceof UnauthorizedError || e instanceof InvalidInputError || e instanceof NotConfiguredError) {
    return { ok: false, code: e.code, message: e.message, requestId: "" };
  }
  return { ok: false, code: "UNKNOWN", message: "Something went wrong.", requestId: "" };
}

/** Session check first, then input validation, then the API call (security review C-2, C-5). */
async function run<T>(fn: () => Promise<T>, revalidate = true): Promise<ActionResult<T>> {
  try {
    await requireSession();
    const data = await fn();
    if (revalidate) revalidatePath("/incidents", "layout");
    return { ok: true, data };
  } catch (e) {
    return fail(e);
  }
}

export async function ackIncident(id: string, version: number) {
  return run(async () => {
    const [i, v] = [assertId(id), assertVersion(version)];
    await (await getApi()).ack(i, v);
    return null;
  });
}
export async function resolveIncident(id: string, version: number) {
  return run(async () => {
    const [i, v] = [assertId(id), assertVersion(version)];
    await (await getApi()).resolve(i, v, {});
    return null;
  });
}
export async function escalateIncident(id: string) {
  return run(async () => {
    const i = assertId(id);
    await (await getApi()).escalate(i);
    return null;
  });
}
export async function previewBulk(action: "ack" | "resolve", ids: string[]): Promise<ActionResult<BulkPreview>> {
  return run(async () => {
    const [a, list] = [assertBulkAction(action), assertIds(ids)];
    return (await getApi()).bulkPreview(a, list);
  }, false);
}
export async function executeBulk(action: "ack" | "resolve", ids: string[]): Promise<ActionResult<BulkResult>> {
  return run(async () => {
    const [a, list] = [assertBulkAction(action), assertIds(ids)];
    return (await getApi()).bulkExecute(a, list);
  });
}
export async function undoBulk(token: string) {
  return run(async () => {
    const t = assertToken(token);
    await (await getApi()).bulkUndo(t);
    return null;
  });
}
