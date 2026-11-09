export type Severity = "SEV_1" | "SEV_2" | "SEV_3" | "SEV_4" | "SEV_5";
export type Shape = "dot" | "tri" | "dia" | "ring" | "dash" | "chk";

/** SEV-1 ● · SEV-2 ▲ · SEV-3 ◆ · SEV-4 ○ · SEV-5 – (docs/ui/README.md) */
export const SEVERITY_META: Record<Severity, { label: string; shape: Shape; glyph: string; cls: string }> = {
  SEV_1: { label: "SEV-1", shape: "dot", glyph: "●", cls: "s1" },
  SEV_2: { label: "SEV-2", shape: "tri", glyph: "▲", cls: "s2" },
  SEV_3: { label: "SEV-3", shape: "dia", glyph: "◆", cls: "s3" },
  SEV_4: { label: "SEV-4", shape: "ring", glyph: "○", cls: "s4" },
  SEV_5: { label: "SEV-5", shape: "dash", glyph: "–", cls: "s5" },
};

export type DisplayStatus = "TRIGGERED" | "ESCALATED" | "ACKNOWLEDGED" | "RESOLVED" | "MUTED";

/** Triggered ● red · Escalated ▲ orange · Acknowledged ○ slate · Resolved ✓ green · Muted – gray (IA §3) */
export const STATUS_META: Record<DisplayStatus, { label: string; short: string; shape: Shape; cls: string }> = {
  TRIGGERED: { label: "Triggered", short: "Triggered", shape: "dot", cls: "trig" },
  ESCALATED: { label: "Escalated", short: "Escalated", shape: "tri", cls: "esc" },
  ACKNOWLEDGED: { label: "Acknowledged", short: "Ack'd", shape: "ring", cls: "ack" },
  RESOLVED: { label: "Resolved", short: "Resolved", shape: "chk", cls: "res" },
  MUTED: { label: "Muted", short: "Muted", shape: "dash", cls: "mute" },
};

export const SEVERITIES = Object.keys(SEVERITY_META) as Severity[];
export const STATUSES = Object.keys(STATUS_META) as DisplayStatus[];

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "–";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}
