"use server";
import { revalidatePath } from "next/cache";
import { getApi } from "@/lib/api";
import { requireSession } from "@/lib/auth";
import { requireRole } from "@/lib/auth/role";
import { assertId, assertVersion, InvalidInputError } from "@/lib/validate";
import { MEMBERS_MAX, NAME_MAX } from "@/lib/templates";
import type { ResponderTemplate, TemplatePreview, TemplateProposal, TemplateSaveResult } from "@/lib/api/types";
import { fail, type ActionResult } from "@/lib/action-result";

/**
 * Call order › Templates writes (API-CONTRACT §8.3, D-41, D-64): ADMIN only. Session first, then the role, then the input, then the
 * API call (which retries a 503 BUSY once). The API checks again — all-customer range, the name, who may be a member, the
 * version, the preview hash, and what a change must not do — and what it answers wins.
 */
async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    await requireSession();
    await requireRole("ADMIN");
    const data = await fn();
    revalidatePath("/call-order/templates");
    // the tree's call health and the panels' Responders follow the template too
    revalidatePath("/", "layout");
    return { ok: true, data };
  } catch (e) {
    return fail(e);
  }
}

const name = (v: unknown): string => {
  const n = typeof v === "string" ? v.trim() : "";
  if (!n || n.length > NAME_MAX) throw new InvalidInputError(`Enter a name of 1 to ${NAME_MAX} characters.`);
  return n;
};
const members = (v: unknown): string[] => {
  if (!Array.isArray(v) || v.length < 1 || v.length > MEMBERS_MAX) throw new InvalidInputError(`A template has 1 to ${MEMBERS_MAX} people.`);
  return v.map((m) => assertId(m, "person"));
};
function proposal(v: unknown): TemplateProposal {
  const o = (v ?? {}) as Record<string, unknown>;
  if (Object.keys(o).some((k) => !["name", "members"].includes(k))) throw new InvalidInputError("Invalid input.");
  if (o.name === undefined && o.members === undefined) throw new InvalidInputError("Nothing to change.");
  return { ...(o.name !== undefined ? { name: name(o.name) } : {}), ...(o.members !== undefined ? { members: members(o.members) } : {}) };
}
const hash = (v: unknown): string => {
  if (typeof v !== "string" || !/^[0-9a-f]{64}$/.test(v)) throw new InvalidInputError("Preview the change first.");
  return v;
};

/** POST /responder-templates. A new template has no customers, so there is no preview. */
export async function createTemplate(input: unknown): Promise<ActionResult<ResponderTemplate>> {
  return run(async () => {
    const o = (input ?? {}) as Record<string, unknown>;
    if (Object.keys(o).some((k) => !["name", "members"].includes(k))) throw new InvalidInputError("Invalid input.");
    return (await getApi()).createResponderTemplate({ name: name(o.name), members: members(o.members) });
  });
}

/** POST /responder-templates/{id}/preview: nothing is written */
export async function previewTemplate(id: string, p: unknown): Promise<ActionResult<TemplatePreview>> {
  return run(async () => (await getApi()).previewResponderTemplate(assertId(id, "template"), proposal(p)));
}

/** PATCH /responder-templates/{id}: `version` is the If-Match, `previewHash` the one of the preview of exactly this change */
export async function saveTemplate(id: string, p: unknown, version: number, previewHash: string): Promise<ActionResult<TemplateSaveResult>> {
  return run(async () => (await getApi()).saveResponderTemplate(assertId(id, "template"), proposal(p), { version: assertVersion(version), previewHash: hash(previewHash) }));
}
