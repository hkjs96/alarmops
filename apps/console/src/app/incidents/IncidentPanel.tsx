"use client";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { Panel } from "@alarmops/design-system";

/**
 * The incident in the scope panel. The panel's address is its path alone; `listHref` (the list with the reader's
 * filter) is where closing goes. Copy link leaves the filter out, so the receiver keeps their own (T13).
 */
export function IncidentPanel({ id, path, pathLabel, note, panelPath, listHref, children }: {
  id: string; path: string[] | null; pathLabel?: string; note?: string; panelPath: string; listHref: string; children: ReactNode;
}) {
  const router = useRouter();
  const close = () => {
    try { sessionStorage.setItem("ao-focus-row", id); } catch { /* focus goes to the page instead */ }
    router.push(listHref);
  };
  const copy = async () => {
    await navigator.clipboard.writeText(window.location.origin + panelPath);
  };
  return (
    <Panel kind="Incident" path={path} pathLabel={pathLabel} note={note} onClose={close} onCopyLink={copy}>
      {children}
    </Panel>
  );
}
