"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button, ConfirmDialog, Mark } from "@alarmops/design-system";
import type { MonitoringAction, ResourceItem } from "@/lib/api/types";
import { age } from "@/lib/format";
import { callAction } from "@/lib/session-ended";
import { canRetag, canStop, doneText, monitoringError, reasonText, stopPrompt } from "@/lib/monitoring";
import { OrgPath, ResourceCell } from "./MonitoringTables";
import { setMonitoring } from "./actions";

/** how often the list is read again while a command is waiting, and for how long (the engine answers within seconds) */
export const POLL_MS = 4000;
export const POLL_MAX = 15;

type Row = { done?: MonitoringAction; error?: string; busy?: MonitoringAction };

/**
 * Needs review (D-16): Resource · Since · Reason · Alarms kept · Re-tag / Stop monitoring. There is no Keep button: the engine has no command for it (API answers 409 NOT_SUPPORTED), so it would only mislead.
 * Stop deletes the resource's alarms, so it asks first and names how many go. Nothing is assumed from a 202: the row
 * says "Stop queued" and the list is read again until the resource has left it.
 */
export function NeedsReviewTable({ items, now, canWrite, readOnlyReason }: { items: ResourceItem[]; now: number; canWrite: boolean; readOnlyReason?: string }) {
  const router = useRouter();
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [confirm, setConfirm] = useState<ResourceItem | null>(null);
  const [say, setSay] = useState("");
  const polls = useRef(0);
  const waiting = Object.values(rows).some((r) => r.done);

  // read the list again while something is queued; a row that has left the list drops its note on its own
  useEffect(() => {
    if (!waiting) { polls.current = 0; return; }
    const t = setInterval(() => { if (polls.current++ < POLL_MAX) router.refresh(); }, POLL_MS);
    return () => clearInterval(t);
  }, [waiting, router]);

  const set = (id: string, patch: Row | null) => setRows((m) => { const n = { ...m }; if (patch) n[id] = patch; else delete n[id]; return n; });

  async function run(r: ResourceItem, action: MonitoringAction) {
    set(r.id, { busy: action });
    const res = await callAction(() => setMonitoring(r.id, action));
    if (res.ok) {
      set(r.id, { done: action });
      setSay(`${doneText(action)} for ${r.name}.`);
      router.refresh();
    } else {
      set(r.id, { error: monitoringError(res, action, r.name) });
    }
  }

  const noRetag = (r: ResourceItem) => !canRetag(r);
  return (
    <>
      <div className="tw">
        <table className="t mon nr" data-testid="needs-review-table">
          <thead>
            <tr>
              <th className="c-res" scope="col">Resource</th><th className="c-org" scope="col">Customer / account</th><th className="c-since" scope="col">Since</th>
              <th className="c-reason" scope="col">Reason</th><th className="c-n" scope="col">Alarms kept</th><th className="c-act" scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((r) => {
              const st = rows[r.id] ?? {};
              const off = !canWrite || Boolean(st.busy) || Boolean(st.done);
              return (
                <tr key={r.id} data-testid="needs-review-row" data-resource={r.id}>
                  <td className="c-res"><ResourceCell name={r.name} resourceKey={r.resourceKey} /></td>
                  <td className="c-org"><OrgPath org={r.org} /></td>
                  <td className="c-since" data-label="Since">{r.needsReviewSince ? `${age(r.needsReviewSince, now)} ago` : "—"}</td>
                  <td className="c-reason" data-label="Reason">{reasonText(r.needsReviewReason)}</td>
                  <td className="c-n" data-label="Alarms kept">{r.alarmCount}</td>
                  <td className="c-act">
                    {st.done ? (
                      <span className="st info mon-done" role="status" data-testid="row-done"><Mark shape="ring" />{doneText(st.done)}</span>
                    ) : (
                      <span className="mon-acts">
                        <span className="mon-act">
                          <Button size="sm" disabled={off || noRetag(r)} onClick={() => run(r, "tag_on")} aria-describedby={noRetag(r) ? `rt-${r.id}` : undefined}>Re-tag</Button>
                          {noRetag(r) ? <span id={`rt-${r.id}`} className="mon-hint" data-testid="retag-hint">Enable TagWriter role</span> : null}
                        </span>
                        <span className="mon-act">
                          <Button size="sm" variant="danger" disabled={off || !canStop(r)} onClick={() => { setSay(""); setConfirm(r); }} aria-describedby={canStop(r) ? undefined : `st-${r.id}`}>Stop monitoring</Button>
                          {canStop(r) ? null : <span id={`st-${r.id}`} className="mon-hint" data-testid="stop-hint">Enable AlarmWriter role</span>}
                        </span>
                      </span>
                    )}
                    {st.error ? <span className="mon-err" role="alert" data-testid="row-error">{st.error}</span> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!canWrite && readOnlyReason ? <p className="sm mut" data-testid="readonly-note">{readOnlyReason}</p> : null}
      <div className="sr-only" aria-live="polite" data-testid="mon-live">{say}</div>
      <ConfirmDialog
        open={confirm !== null}
        title={confirm ? `Stop monitoring ${confirm.name}` : ""}
        confirmLabel="Stop monitoring"
        danger
        onCancel={() => setConfirm(null)}
        onConfirm={() => { const r = confirm; setConfirm(null); if (r) void run(r, "stop"); }}
      >
        {confirm ? <p data-testid="stop-prompt">{stopPrompt(confirm)}</p> : null}
      </ConfirmDialog>
    </>
  );
}
