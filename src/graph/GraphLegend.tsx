export function GraphLegend() {
  return (
    <div className="graph-legend">
      <div><span className="dot seed" /> Seed paper</div>
      <div><span className="dot cited" /> Reference <span className="faint">— cited by a paper in the map</span></div>
      <div><span className="dot citing" /> Citation <span className="faint">— cites a paper in the map</span></div>
      <div><span className="dot both" /> Both <span className="faint">— reference and citation</span></div>
      <div className="faint small">Size ∝ citation count · ring = connections loaded · dot = pinned</div>
    </div>
  );
}
