import { useId, type SelectHTMLAttributes } from "react";
import { cx } from "../cx";

export interface SelectOption { value: string; label: string }
export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "children"> {
  /** inline mono key shown inside the control, e.g. "Sev" */
  label: string;
  options: SelectOption[];
}

export function Select({ label, options, className, id, ...rest }: SelectProps) {
  const gen = useId();
  const sid = id ?? gen;
  return (
    <span className={cx("sel", className)}>
      <label className="k" htmlFor={sid}>{label}</label>
      <select id={sid} {...rest}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <span className="car" aria-hidden="true">▼</span>
    </span>
  );
}
