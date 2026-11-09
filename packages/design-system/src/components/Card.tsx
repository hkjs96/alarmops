import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../cx";

export type CardAccent = "red" | "orange" | "amber" | "accent" | "green";
export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title?: ReactNode;
  actions?: ReactNode;
  accent?: CardAccent;
  dashed?: boolean;
  bodyless?: boolean;
}

export function Card({ title, actions, accent, dashed, bodyless, className, children, ...rest }: CardProps) {
  return (
    <section className={cx("card", accent && `lb-${accent}`, dashed && "dashed", className)} {...rest}>
      {title != null || actions != null ? (
        <div className="card-h">
          {typeof title === "string" ? <h2 className="ov" style={{ margin: 0 }}>{title}</h2> : title}
          <span className="sp" />
          {actions}
        </div>
      ) : null}
      {bodyless ? children : <div className="card-b">{children}</div>}
    </section>
  );
}
