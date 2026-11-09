import { EmptyState } from "@alarmops/design-system";
import { SubNav } from "./SubNav";

export function StubPage({ title, spec }: { title: string; spec: string }) {
  return (
    <div className="page">
      <div className="ph"><div><h1>{title}</h1></div></div>
      <SubNav />
      <div className="card">
        <EmptyState title="Not built yet" detail={<>This screen is stubbed. Spec: <code>{spec}</code></>} />
      </div>
    </div>
  );
}
