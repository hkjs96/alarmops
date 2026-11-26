import { Mark, SevBadge, SourceChip, type Shape } from "@alarmops/design-system";
import type { AlarmState, ManagedAlarmItem, MonitoringState, OrgChain, ResourceItem } from "@/lib/api/types";
import { age } from "@/lib/format";
import { reasonText } from "@/lib/monitoring";

/** Every state is color + shape + text (docs/ui/README.md): the color alone never says it. */
const MON: Record<MonitoringState, { label: string; cls: string; shape: Shape }> = {
  MONITORED: { label: "Monitored", cls: "res", shape: "chk" },
  NEEDS_REVIEW: { label: "Needs review", cls: "warn", shape: "tri" },
  NOT_MONITORED: { label: "Not monitored", cls: "mute", shape: "dash" },
  DELETED: { label: "Deleted", cls: "mute", shape: "dash" },
};
const ALM: Record<AlarmState, { label: string; cls: string; shape: Shape }> = {
  ALARM: { label: "ALARM", cls: "trig", shape: "dot" },
  OK: { label: "OK", cls: "res", shape: "chk" },
  INSUFFICIENT_DATA: { label: "No data", cls: "mute", shape: "dash" },
};
export function MonitoringStateBadge({ state }: { state: MonitoringState }) {
  const m = MON[state];
  return <span className={`st ${m.cls}`}><Mark shape={m.shape} />{m.label}</span>;
}
export function AlarmStateBadge({ state }: { state: AlarmState | null }) {
  const m = ALM[state ?? "INSUFFICIENT_DATA"];
  return <span className={`st ${m.cls}`}><Mark shape={m.shape} />{m.label}</span>;
}

export function OrgPath({ org }: { org: OrgChain }) {
  const parts = [org.customer?.name, org.project?.name, org.service?.name].filter((x): x is string => Boolean(x));
  if (!parts.length) return <span className="mut">—</span>;
  const [first, ...rest] = parts;
  return (
    <span className="mon-path">
      <b>{first}</b>
      {rest.map((p, n) => <span key={n}><span className="chain" aria-hidden="true"> › </span><wbr />{p}</span>)}
    </span>
  );
}

export function ResourceCell({ name, resourceKey }: { name: string; resourceKey?: string }) {
  return (
    <span className="mon-res">
      <span className="ttl">{name}</span>
      {resourceKey ? <span className="mono sm mut mon-key" title={resourceKey}>{resourceKey}</span> : null}
    </span>
  );
}

export const alarmCountText = (n: number) => `${n} alarm${n === 1 ? "" : "s"}`;

/** Resources: Resource · Type · Customer / account · Monitoring · Alarms · Last seen. (Drift has no data yet and is left out.) */
export function ResourcesTable({ items, now }: { items: ResourceItem[]; now: number }) {
  return (
    <div className="tw">
      <table className="t mon" data-testid="resources-table">
        <thead>
          <tr>
            <th className="c-res" scope="col">Resource</th><th className="c-type" scope="col">Type</th><th className="c-org" scope="col">Customer / account</th>
            <th className="c-state" scope="col">Monitoring</th><th className="c-n" scope="col">Alarms</th><th className="c-seen" scope="col">Last seen</th>
          </tr>
        </thead>
        <tbody>
          {items.map((r) => (
            <tr key={r.id} data-testid="resource-row">
              <td className="c-res"><ResourceCell name={r.name} resourceKey={r.resourceKey} /></td>
              <td className="c-type" data-label="Type">{r.resourceType}<span className="sub mut"> · {r.region}</span></td>
              <td className="c-org"><OrgPath org={r.org} />{r.account ? <span className="sub mono mut">{[r.account.alias, r.account.awsAccountId].filter(Boolean).join(" · ") || "—"}</span> : null}</td>
              <td className="c-state"><MonitoringStateBadge state={r.monitoringState} /></td>
              <td className="c-n" data-label="Alarms">{r.alarmCount}</td>
              <td className="c-seen" data-label="Last seen">{r.lastSeenAt ? `${age(r.lastSeenAt, now)} ago` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Alarms: Alarm (resource + metric) · Threshold + source · Sev · State. (M/N and Drift have no data yet and are left out.) */
export function AlarmsTable({ items }: { items: ManagedAlarmItem[] }) {
  return (
    <div className="tw">
      <table className="t mon" data-testid="alarms-table">
        <thead>
          <tr>
            <th className="c-res" scope="col">Alarm</th><th className="c-org" scope="col">Customer</th><th className="c-thr" scope="col">Threshold</th>
            <th className="c-sev" scope="col">Sev</th><th className="c-state" scope="col">State</th>
          </tr>
        </thead>
        <tbody>
          {items.map((a) => (
            <tr key={a.id} data-testid="alarm-row" className={a.state === "ALARM" ? "hot" : undefined}>
              <td className="c-res"><span className="mon-res"><span className="ttl">{a.resourceName}</span><span className="mono sm mut">{a.metricKey} · {a.resourceType}</span></span></td>
              <td className="c-org"><OrgPath org={a.org} /></td>
              <td className="c-thr" data-label="Threshold">
                {a.threshold === null ? <span className="mut">—</span> : <span className="mono">{a.threshold}</span>}
                {a.thresholdSource ? <> <SourceChip source={a.thresholdSource} /></> : null}
              </td>
              <td className="c-sev"><SevBadge severity={a.severity} /></td>
              <td className="c-state"><AlarmStateBadge state={a.state} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export { reasonText };
