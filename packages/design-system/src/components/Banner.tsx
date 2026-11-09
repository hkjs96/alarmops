import type { ReactNode } from "react";
import { Mark } from "./Mark";
import type { Shape } from "../severity";

export type BannerTone = "amber" | "accent" | "red" | "green";
const TONE: Record<BannerTone, { shape: Shape; st: string }> = {
  amber: { shape: "tri", st: "warn" },
  accent: { shape: "ring", st: "info" },
  red: { shape: "dot", st: "trig" },
  green: { shape: "chk", st: "res" },
};

export function Banner({ tone = "accent", children, action }: { tone?: BannerTone; children: ReactNode; action?: ReactNode }) {
  const t = TONE[tone];
  return (
    <div className={`banner ${tone}`} role={tone === "red" ? "alert" : "status"}>
      <span className={`st ${t.st}`}><Mark shape={t.shape} /></span>
      <span>{children}</span>
      {action ? (<><span className="sp" />{action}</>) : null}
    </div>
  );
}
