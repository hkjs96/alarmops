"use server";
import { getApi } from "@/lib/api";
import { requireSession } from "@/lib/auth";
import { assertId, InvalidInputError } from "@/lib/validate";
import type { RevealChannel, RevealResult } from "@/lib/api/types";
import { fail, type ActionResult } from "@/lib/action-result";

const CHANNELS: readonly RevealChannel[] = ["PHONE", "EMAIL", "SLACK"];
const REASON_MAX = 500;

/**
 * Show a contact's full value (D-35, POST /contacts/{id}/reveal). This is a read that the API logs, so it is open to
 * a portal user too (their own customer's people); the API decides who may and which mode applies: the console never
 * sends a mode. The value goes back to the one call that asked and is never logged or kept here.
 */
export async function revealContact(contactId: string, channel: RevealChannel, reason?: string): Promise<ActionResult<RevealResult>> {
  try {
    await requireSession();
    const id = assertId(contactId, "contactId");
    if (!CHANNELS.includes(channel)) throw new InvalidInputError("Invalid channel.");
    if (reason !== undefined && (typeof reason !== "string" || reason.trim().length > REASON_MAX)) throw new InvalidInputError(`Give a reason of up to ${REASON_MAX} characters.`);
    const text = reason?.trim();
    return { ok: true, data: await (await getApi()).revealContact(id, { channel, ...(text ? { reason: text } : {}) }) };
  } catch (e) {
    return fail(e);
  }
}
