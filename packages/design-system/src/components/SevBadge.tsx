import { SEVERITY_META, type Severity } from "../severity";
import { cx } from "../cx";
import { Mark } from "./Mark";

/** Severity = color + shape + text. SEV-1 gets the solid "hot" treatment when `hot`. */
export function SevBadge({ severity, hot }: { severity: Severity; hot?: boolean }) {
  const m = SEVERITY_META[severity];
  return (
    <span className={cx("sev", m.cls, hot && severity === "SEV_1" && "hot")} data-severity={severity}>
      <Mark shape={m.shape} />
      {m.label}
    </span>
  );
}
