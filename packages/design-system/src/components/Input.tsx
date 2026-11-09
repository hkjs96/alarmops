import { useId, type InputHTMLAttributes } from "react";
import { cx } from "../cx";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  /** visually hidden label (still announced) */
  hideLabel?: boolean;
}

export function Input({ label, hint, hideLabel, className, id, ...rest }: InputProps) {
  const gen = useId();
  const iid = id ?? gen;
  return (
    <div className={className}>
      {label ? (
        <label htmlFor={iid} className={hideLabel ? "sr-only" : "lab"}>
          {label}
        </label>
      ) : null}
      <input id={iid} className={cx("inp")} aria-describedby={hint ? `${iid}-h` : undefined} {...rest} />
      {hint ? <div id={`${iid}-h`} className="hint">{hint}</div> : null}
    </div>
  );
}
