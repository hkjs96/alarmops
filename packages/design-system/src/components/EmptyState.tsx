import type { ReactNode } from "react";

export function EmptyState({ title, detail, action }: { title: string; detail?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty" role="status">
      <div className="t1">{title}</div>
      {detail ? <div className="t2">{detail}</div> : null}
      {action ? <div className="act">{action}</div> : null}
    </div>
  );
}
