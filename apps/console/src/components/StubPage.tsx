import { EmptyState } from "@alarmops/design-system";
import { SubNav } from "./SubNav";
import { ScopeEcho } from "./ShellContext";

/** Screens that are not built yet still live in the scope shell: tree, filter line and the filter in the address work. */
export function StubPage({ title, spec, desc, scoped = true }: { title: string; spec: string; desc?: string; scoped?: boolean }) {
  return (
    <div className="page">
      <div className="ph"><div><h1 tabIndex={-1}>{title}</h1>{desc ? <div className="desc">{desc}</div> : null}</div></div>
      <SubNav />
      <div className="card">
        <EmptyState
          title="Not built yet"
          detail={<>
            {scoped ? <>This list will show <ScopeEcho />. </> : null}
            This screen is stubbed. Spec: <code>{spec}</code>
          </>}
        />
      </div>
    </div>
  );
}
