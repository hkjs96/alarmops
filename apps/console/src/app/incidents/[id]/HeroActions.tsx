"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Banner, Button } from "@alarmops/design-system";
import type { IncidentStatus } from "@/lib/api/types";
import { ackIncident, escalateIncident, resolveIncident } from "../actions";

/** One primary button: Acknowledge (Triggered) → Resolve (Acknowledged). */
export function HeroActions({ id, status, version, canEscalate }: { id: string; status: IncidentStatus; version: number; canEscalate: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<{ conflict: boolean; msg: string } | null>(null);
  const act = (fn: () => Promise<{ ok: boolean; code?: string; message?: string }>) => start(async () => {
    const r = await fn();
    if (!r.ok) setErr({ conflict: r.code === "VERSION_CONFLICT", msg: r.message ?? "Failed." });
    else setErr(null);
    router.refresh();
  });
  if (status === "RESOLVED") return null;
  return (
    <div className="hero-actions-wrap">
      <div className="row hero-actions">
        <Button disabled title="Maintenance windows are not built yet">Mute 1h</Button>
        {status === "TRIGGERED" ? <Button onClick={() => act(() => escalateIncident(id))} disabled={pending || !canEscalate}>Escalate now</Button> : null}
        {status === "TRIGGERED" ? (
          <Button variant="primary" size="lg" onClick={() => act(() => ackIncident(id, version))} disabled={pending}>Acknowledge</Button>
        ) : (
          <Button variant="primary" size="lg" onClick={() => act(() => resolveIncident(id, version))} disabled={pending}>Resolve</Button>
        )}
      </div>
      {err ? (
        <div style={{ marginTop: 10 }}>
          <Banner tone="red" action={<Button size="sm" onClick={() => { setErr(null); router.refresh(); }}>Reload</Button>}>
            {err.conflict ? "Someone else updated this incident." : err.msg}
          </Banner>
        </div>
      ) : null}
    </div>
  );
}
