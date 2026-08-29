import { useCallback, useRef, useState } from 'react';
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
  // Height of the legend overlay (+ its 10px offset and a small gap) so canvas axis labels
  // can render above it instead of underneath. 0 while the legend is closed/unmounted.
  const [legendInset, setLegendInset] = useState(0);
  const legendRO = useRef<ResizeObserver | null>(null);
  const legendEl = useCallback((el: HTMLDivElement | null) => {
    legendRO.current?.disconnect();
    legendRO.current = null;
    if (!el) {
      setLegendInset(0);
      return;
    }
    const update = () => setLegendInset(el.offsetHeight + 16);
    update();
    legendRO.current = new ResizeObserver(update);
    legendRO.current.observe(el);
  }, []);
  return (
    <section className="graph-panel" aria-label="Reference map">
      <div className="graph-stage">
        <GraphCanvas controlsRef={controls} themeKey={themeKey} visibleRoleMask={visibleRoleMask} bottomInset={legendInset} />
        <GraphToolbar controls={controls} legendOpen={legendOpen} onToggleLegend={() => setLegendOpen((v) => !v)} tab={tab} onTab={onTab} />
        {legendOpen && !empty && (
          <GraphLegend
            visibleRoleMask={visibleRoleMask}
            onToggleRole={(role) => setVisibleRoleMask((mask) => mask ^ (1 << role))}
            rootRef={legendEl}
          />
        )}
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
