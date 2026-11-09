export default function Loading() {
  return (
    <div className="page" aria-busy="true">
      <div className="ph"><div><h1>Incidents</h1></div></div>
      <div className="tiles">{["Triggered", "Escalated", "Acknowledged", "Resolved · 24h", "Muted"].map((t) => (
        <div className="tile" key={t}><div className="ov">{t}</div><div className="v">—</div></div>
      ))}</div>
      <div className="tw">{Array.from({ length: 8 }, (_, i) => (
        <div key={i} style={{ padding: "16px 12px", borderBottom: "1px solid var(--grid)" }}><div className="skel" style={{ width: `${60 + (i % 3) * 12}%` }} /></div>
      ))}</div>
    </div>
  );
}
