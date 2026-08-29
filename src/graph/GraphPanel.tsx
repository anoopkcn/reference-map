import { useRef, useState } from 'react';
import type { Tab } from '../App';
import { Icon } from '../components/icons';
import { useAppStore } from '../store';
import { GraphCanvas, type GraphControls } from './GraphCanvas';
import { ALL_ROLE_MASK } from './frame';
import { GraphLegend } from './GraphLegend';
import { GraphToolbar } from './GraphToolbar';
import { SidePanel } from './SidePanel';

export function GraphPanel({ themeKey, tab, onTab }: { themeKey: string; tab: Tab; onTab: (t: Tab) => void }) {
  const controls = useRef<GraphControls | null>(null);
  const [legendOpen, setLegendOpen] = useState(true);
  const [visibleRoleMask, setVisibleRoleMask] = useState(ALL_ROLE_MASK);
  const empty = useAppStore((s) => (s.graphVersion, s.graph.nodeCount === 0));
  const resolving = useAppStore((s) => s.seeds.some((x) => x.status === 'resolving'));
  return (
    <section className="graph-panel" aria-label="Reference map">
      <div className="graph-stage">
        <GraphCanvas controlsRef={controls} themeKey={themeKey} visibleRoleMask={visibleRoleMask} />
        <GraphToolbar controls={controls} legendOpen={legendOpen} onToggleLegend={() => setLegendOpen((v) => !v)} tab={tab} onTab={onTab} />
        {legendOpen && !empty && (
          <GraphLegend
            visibleRoleMask={visibleRoleMask}
            onToggleRole={(role) => setVisibleRoleMask((mask) => mask ^ (1 << role))}
          />
        )}
        <GraphStats />
        {empty && (
          <div className="graph-empty">
            {resolving ? (
              <><span className="spinner" /> Looking up paper…</>
            ) : (
              <>
                <Icon name="graph" size={30} />
                <div>The map appears here once you add a paper.</div>
                <div className="faint small">Scroll to zoom · drag the background to pan · drag a node to pin it</div>
              </>
            )}
          </div>
        )}
      </div>
      <SidePanel />
    </section>
  );
}

/** Paper/connection counts (and the expansion spinner), pinned to the bottom-right of the map. */
function GraphStats() {
  const nodes = useAppStore((s) => (s.graphVersion, s.graph.nodeCount));
  const edges = useAppStore((s) => (s.graphVersion, s.graph.edgeCount));
  const expanding = useAppStore((s) => s.expanding.size);
  if (nodes === 0 && expanding === 0) return null;
  return (
    <div className="graph-stats">
      {nodes > 0 && <span>{nodes.toLocaleString()} papers · {edges.toLocaleString()} connections</span>}
      {expanding > 0 && <span className="row"><span className="spinner" /> loading connections…</span>}
    </div>
  );
}
