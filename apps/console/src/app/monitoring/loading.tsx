/** Loading: a skeleton of the tiles and a table, so the page does not jump (docs/ui/screens/monitoring.md "로딩"). */
export default function Loading() {
  return (
    <div className="page" aria-busy="true" data-testid="mon-loading">
      <div className="ph"><div><h1>Monitoring</h1></div></div>
      <span className="sr-only" role="status">Loading monitoring…</span>
      <div className="mon-skel-tiles" aria-hidden="true">{[0, 1, 2].map((i) => <div key={i} className="mon-skel" style={{ height: 76 }} />)}</div>
      <div className="mon-skel-rows" aria-hidden="true">{[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="mon-skel" style={{ height: 44 }} />)}</div>
    </div>
  );
}
