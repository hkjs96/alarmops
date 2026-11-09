"use server";
import { revalidatePath } from "next/cache";
import { getApi } from "@/lib/api";
import { ApiError } from "@/lib/api/client";
import type { BulkPreview, BulkResult } from "@/lib/api/types";

export type ActionResult<T = null> = { ok: true; data: T } | { ok: false; code: string; message: string; requestId: string };

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    const data = await fn();
    revalidatePath("/incidents", "layout");
    return { ok: true, data };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, code: e.code, message: e.message, requestId: e.requestId };
    return { ok: false, code: "UNKNOWN", message: "Something went wrong.", requestId: "" };
  }
}

export async function ackIncident(id: string, version: number) {
  return run(async () => { await getApi().ack(id, version); return null; });
}
export async function resolveIncident(id: string, version: number) {
  return run(async () => { await getApi().resolve(id, version, {}); return null; });
}
export async function escalateIncident(id: string) {
  return run(async () => { await getApi().escalate(id); return null; });
}
export async function previewBulk(action: "ack" | "resolve", ids: string[]): Promise<ActionResult<BulkPreview>> {
  try {
    return { ok: true, data: await getApi().bulkPreview(action, ids) };
  } catch (e) {
    const err = e instanceof ApiError ? e : new ApiError(500, "UNKNOWN", "Something went wrong.", "");
    return { ok: false, code: err.code, message: err.message, requestId: err.requestId };
  }
}
export async function executeBulk(action: "ack" | "resolve", ids: string[]): Promise<ActionResult<BulkResult>> {
  return run(() => getApi().bulkExecute(action, ids));
}
export async function undoBulk(token: string) {
  return run(async () => { await getApi().bulkUndo(token); return null; });
}
