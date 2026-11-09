import { STATUS_META, type DisplayStatus } from "../severity";
import { Mark } from "./Mark";

export function StatusBadge({ status, short, suffix }: { status: DisplayStatus; short?: boolean; suffix?: string }) {
  const m = STATUS_META[status];
  return (
    <span className={`st ${m.cls}`} data-status={status}>
      <Mark shape={m.shape} />
      {short ? m.short : m.label}
      {suffix ? ` · ${suffix}` : null}
    </span>
  );
}
