import { initials } from "../severity";
import { cx } from "../cx";

export function Avatar({ name, label, active }: { name: string; label?: string; active?: boolean }) {
  return (
    <span className={cx("av", active && "on")} title={name} aria-hidden="true">
      {label ?? initials(name)}
    </span>
  );
}
