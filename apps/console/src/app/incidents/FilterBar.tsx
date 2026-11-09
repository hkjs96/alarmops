"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Select, SEVERITIES, SEVERITY_META } from "@alarmops/design-system";

export function FilterBar(props: { severity?: string; source?: string; assignee?: string; q?: string }) {
  const router = useRouter();
  const sp = useSearchParams();
  const [text, setText] = useState(props.q ?? "");
  const set = (k: string, v: string) => {
    const p = new URLSearchParams(sp.toString());
    if (v) p.set(k, v);
    else p.delete(k);
    const s = p.toString();
    router.push(s ? `/incidents?${s}` : "/incidents");
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    set("q", text.trim());
  };
  return (
    <div className="row">
      <Select label="Sev" value={props.severity ?? ""} onChange={(e) => set("severity", e.target.value)}
        options={[{ value: "", label: "Any" }, ...SEVERITIES.map((s) => ({ value: s, label: SEVERITY_META[s].label }))]} />
      <Select className="hide-m" label="Source" value={props.source ?? ""} onChange={(e) => set("source", e.target.value)}
        options={[{ value: "", label: "Any" }, { value: "CLOUDWATCH", label: "CloudWatch" }, { value: "PROMETHEUS", label: "Prometheus" }, { value: "GRAFANA", label: "Grafana" }]} />
      <Select label="Assignee" value={props.assignee ?? ""} onChange={(e) => set("assignee", e.target.value)}
        options={[{ value: "", label: "Anyone" }, { value: "me", label: "Me" }]} />
      <form role="search" onSubmit={onSubmit} className="hide-m">
        <label htmlFor="inc-q" className="sr-only">Search incidents</label>
        <input id="inc-q" className="inp" style={{ width: 200 }} placeholder="Search title, resource, account" value={text} onChange={(e) => setText(e.target.value)} />
      </form>
    </div>
  );
}
