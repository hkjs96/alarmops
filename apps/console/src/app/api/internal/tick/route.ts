import { NextResponse, type NextRequest } from "next/server";
import { TICK_JOBS, runTick, type TickJob } from "@alarmops/core";
import { backend } from "@/lib/server/backend";
import { tickAuth } from "@/lib/server/tick-auth";
import { NotConfiguredError } from "@/lib/mode";
import { errorTag } from "@/lib/server/error-tag";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** The tick answers within 60 s (API-CONTRACT §5 "예산"); the platform limit must not be lower. */
export const maxDuration = 60;

const err = (status: number, code: string, message: string) => NextResponse.json({ error: { code, message, details: {}, requestId: "" } }, { status, headers: { "cache-control": "no-store" } });

/**
 * POST /api/internal/tick — the 1-minute tick (API-CONTRACT §5, D-23: pg_cron + pg_net call it every minute).
 * No session: the shared secret is the only credential. The runner's clock is the real one (N-40); the store's
 * clock decides due times (R-2). No provider is wired yet, so pages wait in the outbox as NOT_CONFIGURED.
 */
export async function POST(req: NextRequest) {
  const a = tickAuth(req.headers.get("authorization"), process.env);
  if (a === "NOT_CONFIGURED") return err(503, "NOT_CONFIGURED", "TICK_SECRET is not configured.");
  if (a === "DENIED") return err(401, "UNAUTHENTICATED", "Invalid tick credentials.");
  let input: { scheduledAt?: unknown; jobs?: unknown } = {};
  const text = await req.text();
  if (text.length > 4096) return err(413, "PAYLOAD_TOO_LARGE", "Request body too large.");
  if (text) { try { input = JSON.parse(text) as typeof input; } catch { return err(400, "VALIDATION_FAILED", "Body must be JSON."); } }
  const scheduledAt = input.scheduledAt === undefined ? undefined : typeof input.scheduledAt === "string" && !Number.isNaN(Date.parse(input.scheduledAt)) ? new Date(input.scheduledAt) : null;
  if (scheduledAt === null) return err(400, "VALIDATION_FAILED", "scheduledAt must be an ISO time.");
  const jobs = input.jobs === undefined ? undefined : Array.isArray(input.jobs) && input.jobs.every((j) => (TICK_JOBS as readonly unknown[]).includes(j)) ? (input.jobs as TickJob[]) : null;
  if (jobs === null) return err(400, "VALIDATION_FAILED", `jobs must be a list of ${TICK_JOBS.join(", ")}.`);
  try {
    const { repo } = backend();
    const result = await runTick({ scheduledAt, jobs }, { repo, senders: {}, log: (level, msg, data) => console[level === "info" ? "log" : level](`[tick] ${msg}`, data ?? {}) });
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    if (e instanceof NotConfiguredError) return err(503, "NOT_CONFIGURED", e.message);
    console.error("[tick] failed", errorTag(e));
    return err(500, "INTERNAL", "Tick failed.");
  }
}

