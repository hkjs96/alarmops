"use client";
import { useState } from "react";
import { Button, DirtyGuard, OutsideLine, ScopeLine } from "@alarmops/design-system";

/** Scope shell pieces that have no screen of their own yet (the tree, sheet and panel are live on every screen). */
export function ScopeDemo() {
  const [open, setOpen] = useState(false);
  const [last, setLast] = useState("—");
  const done = (what: string) => { setLast(what); setOpen(false); };
  return (
    <div className="stack">
      <div style={{ border: "1px solid var(--rule)" }}>
        <ScopeLine
          customer="Mirae Pay" project="Core" totalCustomers={14} mineCustomers={7} onClear={() => undefined}
          outside={<OutsideLine open={3} unmapped={1} acknowledged={3} href="/incidents" filterLabel="Mirae Pay › Core" totalCustomers={14} />}
        />
      </div>
      <div className="row">
        <Button onClick={() => setOpen(true)}>Open the unsaved-changes dialog</Button>
        <span className="sm mut">Last choice: <b data-testid="guard-choice">{last}</b></span>
      </div>
      <DirtyGuard
        open={open} scopeLabel="Mirae Pay › Core" leavingTo="change the filter"
        onSave={() => done("Save")} onKeepDraft={() => done("Keep draft")} onDiscard={() => done("Discard")} onCancel={() => done("Cancel")}
      />
    </div>
  );
}
