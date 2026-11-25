"use server";
import { revalidatePath } from "next/cache";
import { getApi } from "@/lib/api";
import { requireSession } from "@/lib/auth";
import { requireRole } from "@/lib/auth/role";
import { assertId, InvalidInputError } from "@/lib/validate";
import type { MonitoringAction, MonitoringCommandResult } from "@/lib/api/types";
import { fail, type ActionResult } from "@/lib/action-result";

const ACTIONS: readonly MonitoringAction[] = ["stop", "keep", "tag_on"];

/**
 * Stop / Keep / Re-tag for one resource that needs review (D-16). Session, then role (Operator), then input, then the
 * API call, like every write of the console. The API checks again (403 CAPABILITY_DISABLED when TagWriter is off,
 * 409 when the resource is not waiting for review, 503 when there is no command queue); the page words those.
 * The command is only queued (202): the list is read again by the page, not assumed here.
 */
export async function setMonitoring(resourceId: string, action: MonitoringAction): Promise<ActionResult<MonitoringCommandResult>> {
  try {
    await requireSession();
    await requireRole("OPERATOR");
    const id = assertId(resourceId, "resource");
    if (!ACTIONS.includes(action)) throw new InvalidInputError("Invalid action.");
    const data = await (await getApi()).setMonitoring(id, action);
    revalidatePath("/monitoring", "layout");
    return { ok: true, data };
  } catch (e) {
    return fail(e);
  }
}
