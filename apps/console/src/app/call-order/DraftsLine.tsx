"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { DRAFTS_EVENT, announceDrafts, clearDraft, listDrafts, type CallOrderDraft } from "@/lib/call-order/draft-store";
import { callOrderPath, parseScopeKey } from "@/lib/call-order/model";
import { setEditIntent } from "@/lib/call-order/flags";
import { useShell } from "@/components/ShellContext";

/** "Draft for Mirae Pay · Resume": unsaved edits kept in this tab, each for its own scope. Not shown for the open panel (it says so itself). */
export function DraftsLine({ listQuery, openKey }: { listQuery: string; openKey?: string }) {
  const router = useRouter();
  const shell = useShell();
  const [drafts, setDrafts] = useState<CallOrderDraft[]>([]);
  useEffect(() => {
    const read = () => setDrafts(listDrafts());
    read();
    window.addEventListener(DRAFTS_EVENT, read);
    return () => window.removeEventListener(DRAFTS_EVENT, read);
  }, []);
  const list = drafts.filter((d) => d.scope !== openKey);
  if (list.length === 0) return null;
  return (
    <div className="co-drafts" data-testid="co-drafts">
      {list.map((d) => (
        <div key={d.scope} className="banner accent co-draft" data-testid="co-draft">
          <span className="co-draft-t"><b>Draft for {d.label}</b> · not saved, kept in this tab only</span>
          <span className="co-draft-a">
            <button type="button" className="btn sm" onClick={() => shell.requestLeave(() => { setEditIntent({ scope: d.scope, widenedFrom: d.widenedFrom }); router.push(callOrderPath(parseScopeKey(d.scope)) + listQuery); }, "continue")}>Resume</button>
            <button type="button" className="btn sm ghost" aria-label={`Discard the draft for ${d.label}`} onClick={() => { clearDraft(d.scope); announceDrafts(); shell.toast(`Draft for ${d.label} discarded`); }}>Discard</button>
          </span>
        </div>
      ))}
    </div>
  );
}
