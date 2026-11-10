import {
  Avatar, Banner, Button, Card, EmptyState, Input, Select, SevBadge, SourceChip, StatusBadge, Table, Tabs,
  SEVERITIES, STATUSES, type ThresholdSource,
} from "@alarmops/design-system";
import { ScopeDemo } from "./ScopeDemo";

const TOKENS = ["bg", "surface", "soft", "hair", "rule", "deco", "faint", "mut", "ink2", "ink", "accent", "red", "orange", "slate", "green", "gray", "amber"];
const SOURCES: ThresholdSource[] = ["TAG", "CONSOLE", "CUSTOMER", "MSP", "CODE"];
const rows = [
  { id: "1", name: "payments-db-1", metric: "FreeStorageSpace", src: "CONSOLE" as ThresholdSource },
  { id: "2", name: "batch-worker-3", metric: "CPUUtilization", src: "TAG" as ThresholdSource },
];

export default function DesignPage() {
  return (
    <div className="page stack">
      <div className="ph"><div><h1>Design system</h1><div className="desc">@alarmops/design-system — warm paper, square corners, mono overlines, one blue accent. Toggle theme in the top bar.</div></div></div>

      <Card title="Scope · filter line, outside line, unsaved-changes dialog"><ScopeDemo /></Card>

      <Card title="Color tokens">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 8 }}>
          {TOKENS.map((t) => (
            <div key={t} style={{ border: "1px solid var(--rule)" }}>
              <div style={{ height: 36, background: `var(--${t})` }} />
              <div className="mono xs" style={{ padding: "4px 6px" }}>--{t}</div>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Severity · color + shape + text">
        <div className="row" style={{ gap: 16 }}>{SEVERITIES.map((s) => <SevBadge key={s} severity={s} />)}<SevBadge severity="SEV_1" hot /></div>
      </Card>
      <Card title="Status">
        <div className="row" style={{ gap: 16 }}>{STATUSES.map((s) => <StatusBadge key={s} status={s} />)}</div>
      </Card>
      <Card title="Source chips (D-19)">
        <div className="row">{SOURCES.map((s) => <SourceChip key={s} source={s} />)}</div>
      </Card>
      <Card title="Buttons">
        <div className="row">
          <Button variant="primary">Acknowledge</Button><Button>Escalate now</Button><Button variant="danger">Stop…</Button>
          <Button variant="ghost">Cancel</Button><Button size="sm">Small</Button><Button variant="primary" size="lg">Large primary</Button><Button disabled>Disabled</Button>
        </div>
      </Card>
      <Card title="Inputs">
        <div className="row" style={{ alignItems: "flex-end", gap: 16 }}>
          <Input label="Search" placeholder="Search title, resource, account" hint="Matches title, account, org." style={{ width: 260 }} />
          <Select label="Sev" options={[{ value: "", label: "Any" }, ...SEVERITIES.map((s) => ({ value: s, label: s.replace("_", "-") }))]} />
        </div>
      </Card>
      <Card title="Avatars">
        <div className="row"><Avatar name="Haeun Kim" active /><Avatar name="Junho Park" /><Avatar name="everyone" label="ALL" /></div>
      </Card>
      <div>
        <Banner tone="amber" action={<a className="b" href="#">Map account →</a>}><b>3 alerts from an unmapped AWS account</b> have no owner.</Banner>
        <Banner tone="accent">Info banner.</Banner>
        <Banner tone="red">Error banner.</Banner>
        <Banner tone="green">Updated 2 incidents. You can undo for 5 minutes.</Banner>
      </div>
      <Card title="Cards with accent" bodyless>
        <div className="row" style={{ padding: 16, gap: 12, alignItems: "stretch" }}>
          {(["red", "orange", "amber", "accent", "green"] as const).map((a) => <Card key={a} accent={a} style={{ flex: 1, minWidth: 120 }}>{a}</Card>)}
          <Card dashed style={{ flex: 1, minWidth: 120 }}>dashed</Card>
        </div>
      </Card>
      <Table caption="Example" rows={rows} rowKey={(r) => r.id} columns={[
        { key: "name", header: "Resource", cell: (r) => <span className="ttl">{r.name}</span> },
        { key: "metric", header: "Metric", cell: (r) => <span className="mono sm">{r.metric}</span> },
        { key: "src", header: "Source", cell: (r) => <SourceChip source={r.src} />, align: "right" },
      ]} />
      <section className="card">
        <Tabs label="Example tabs" items={[
          { id: "a", label: "Timeline", content: <div className="card-b">Timeline panel</div> },
          { id: "b", label: "Alerts", count: 3, content: <div className="card-b">Alerts panel</div> },
        ]} />
      </section>
      <Card bodyless><EmptyState title="No open incidents." detail="Last resolved 02:41 KST." action={<Button>Clear filters</Button>} /></Card>
    </div>
  );
}
