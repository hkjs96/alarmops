/**
 * One place that words the API's error codes for the user (API-CONTRACT §2 "오류 형식"). A refused save always says
 * what to change: never a bare "Invalid steps" (QA P2-B). Unknown codes fall back to the server's own message.
 */
import { NO_ANSWER_TEXT, SESSION_ENDED_TEXT } from "./session-ended";
import { MAX_ALL_RESPONDERS, MAX_MINUTE, MAX_REPEAT, MAX_SENDS_PER_CYCLE, MAX_SENDS_PER_HOUR, MAX_STEPS } from "./call-order/limits";

export interface Failure { code: string; message: string; requestId?: string; details?: Record<string, unknown> }
const ROLE_NAME: Record<string, string> = { ADMIN: "Admin", OPERATOR: "Operator", VIEWER: "Viewer" };
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** "steps[3].atMin" → { step: 4, field: "atMin" } */
export function parseField(field: unknown): { step?: number; field: string } {
  const m = /^steps\[(\d+)\](?:\.(\w+))?$/.exec(typeof field === "string" ? field : "");
  return m ? { step: Number(m[1]) + 1, field: m[2] ?? "step" } : { field: typeof field === "string" ? field : "" };
}
function fieldText(f: { field?: unknown; message?: unknown }): string {
  const p = parseField(f.field);
  const said = typeof f.message === "string" ? f.message : "";
  if (p.field === "steps") return `A call order has 1 to ${MAX_STEPS} steps. Remove steps until there are ${MAX_STEPS} or fewer.`;
  if (p.field === "repeatCount") return `Repeat must be a whole number from 0 to ${MAX_REPEAT}.`;
  if (p.step && p.field === "atMin") {
    return /later|after/i.test(said) ? `Step ${p.step} must start later than step ${p.step - 1}. Fix the minutes.` : `Step ${p.step}: minutes must be a whole number from 0 to ${MAX_MINUTE}.`;
  }
  if (p.step && p.field === "channels") return `Step ${p.step}: choose at least one way to send it, each one once (Slack, Slack DM, SMS, Call, Email).`;
  if (p.step && p.field === "targetId") return `Step ${p.step}: the person or rotation it calls does not exist any more. Choose who it calls.`;
  if (p.step && p.field === "targetType") return `Step ${p.step}: choose who it calls.`;
  if (p.field === "confirmName") return "The name does not match. Type the customer name exactly as shown.";
  if (p.field === "reason") return "Give a reason, up to 500 characters.";
  if (p.field === "detail") return "Say what you checked or did, up to 500 characters.";
  if (p.step) return `Step ${p.step}: ${said || "is not valid."}`;
  return said || "A value is not valid.";
}

export interface ErrorContext {
  /** what was being changed, for the role sentence: "Changing the call order" */
  what?: string;
  /** full path of where: "Mirae Pay › Core" */
  where?: string;
}

/** The sentence shown to the user for a failed action. */
export function errorText(f: Failure, ctx: ErrorContext = {}): string {
  const d = f.details ?? {};
  switch (f.code) {
    case "VALIDATION_FAILED": {
      const fields = Array.isArray(d.fields) ? (d.fields as { field?: unknown; message?: unknown }[]) : [];
      return fields.length ? fields.slice(0, 3).map(fieldText).join(" ") : f.message || "A value is not valid.";
    }
    case "SEND_CAP_EXCEEDED": {
      const [c, h] = [num(d.perCycle), num(d.perHour)];
      const over = c !== null && c > MAX_SENDS_PER_CYCLE ? `${c} notifications per incident in one pass of the steps (the limit is ${MAX_SENDS_PER_CYCLE})`
        : h !== null ? `${h} notifications per incident within one hour, repeats included (the limit is ${MAX_SENDS_PER_HOUR})` : "more notifications per incident than the limit allows";
      return `Too many notifications: this call order would send ${over}. Use fewer steps, fewer ways to send per step, or fewer repeats, or call fewer people per step.`;
    }
    case "RESPONDER_LIMIT_EXCEEDED": {
      const p = parseField(d.field);
      const n = num(d.responders);
      return `${p.step ? `Step ${p.step} calls` : "A step that calls"} everyone in Responders${n !== null ? `: ${n} people` : ""}, and the limit is ${num(d.limit) ?? MAX_ALL_RESPONDERS}. Call a rotation or named people instead, or reduce the Responders.`;
    }
    case "NOT_PAGEABLE": {
      const p = parseField(d.field);
      return `${p.step ? `Step ${p.step}: this` : "This"} person is Notify only and cannot be called. Make them Pageable in Responders first, or choose someone else.`;
    }
    // told exactly like "does not exist": the console never confirms that something of another customer is real
    case "CROSS_CUSTOMER": {
      const p = parseField(d.field);
      return p.step ? `Step ${p.step}: the person or rotation it calls was not found for this customer. Choose who it calls.` : "Not found.";
    }
    case "COMMANDS_UNAVAILABLE": return "Alarm deletion can't be sent right now, so the customer was not terminated. Nothing was changed. Try again later or ask the platform team.";
    case "CUSTOMER_TERMINATED": return "A terminated customer cannot change status. To use it again, connect it as a new customer. Reload to see the current state.";
    case "STEP_NOT_MANUAL": return "This step is done by AlarmOps itself and is not waiting for a person. Reload to see where it stands.";
    case "NOT_FOUND": return "Not found. It may have been removed, or you may not have access to it.";
    case "ROLE_REQUIRED": case "FORBIDDEN": case "PORTAL_GRANT_REQUIRED": {
      const role = typeof d.role === "string" ? ROLE_NAME[d.role] ?? d.role : null;
      return `${ctx.what ?? "This"} ${role ? `needs the ${role} role` : "is not allowed for your account"}. Nothing was changed${ctx.where ? ` for ${ctx.where}` : ""}. Ask an admin if you need it.`;
    }
    case "SESSION_ENDED": case "UNAUTHENTICATED": case "UNAUTHORIZED": return SESSION_ENDED_TEXT;
    case "NO_ANSWER": return NO_ANSWER_TEXT;
    case "VERSION_CONFLICT": return "Someone else changed this in the meantime. Nothing was changed — reload to see it as it is now.";
    case "ALREADY_EXISTS": return f.message || "This already exists.";
    case "INVALID_TRANSITION": return f.message || "This is not possible in the state it is in now.";
    case "MUTED_BY_MAINTENANCE": return "Paging for this incident is muted by a maintenance window, so it was not escalated. Only SEV-1 incidents page during maintenance.";
    case "RATE_LIMITED": {
      const s = num(d.retryAfterSec);
      return `That was done a moment ago. Try again${s !== null ? ` in ${Math.ceil(s)} s` : " shortly"}.`;
    }
    case "IDEMPOTENCY_KEY_REUSED": return "This request was sent twice with different content. Reload and try again.";
    case "NOT_CONFIGURED": return "This part of AlarmOps is not configured yet. Nothing was changed.";
    case "WOULD_BE_UNREACHABLE": return f.message || "This would leave nobody reachable.";
    case "INVALID_INPUT": return f.message;
    default: return f.message || "Something went wrong. Nothing was changed.";
  }
}
/** errorText plus the request id support asks for */
export const errorLine = (f: Failure, ctx?: ErrorContext): string => errorText(f, ctx) + (f.requestId ? ` (requestId ${f.requestId})` : "");

/** Why a notification failed, for every audience (`reason` of GET /incidents/{id}/notifications). */
export const FAIL_REASON: Record<string, string> = {
  TIMEOUT: "no answer from the provider in time", INVALID_DESTINATION: "the address or number is not valid", RATE_LIMITED: "the provider is limiting sends",
  PROVIDER_REJECTED: "the provider refused it", PROVIDER_ERROR: "the provider had an error", NOT_CONFIGURED: "this channel is not set up", GAVE_UP: "gave up after retries",
};
