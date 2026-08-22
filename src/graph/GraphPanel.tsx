import { useRef, useState } from 'react';
import type { Tab } from '../App';
import { Icon } from '../components/icons';
import { useAppStore } from '../store';
import { GraphCanvas, type GraphControls } from './GraphCanvas';
import { GraphLegend } from './GraphLegend';
import { GraphToolbar } from './GraphToolbar';
import { SidePanel } from './SidePanel';

export function GraphPanel({ themeKey, tab, onTab }: { themeKey: string; tab: Tab; onTab: (t: Tab) => void }) {
  const controls = useRef<GraphControls | null>(null);
  const [legendOpen, setLegendOpen] = useState(true);
  const empty = useAppStore((s) => (s.graphVersion, s.graph.nodeCount === 0));
  const resolving = useAppStore((s) => s.seeds.some((x) => x.status === 'resolving'));
  return (
    <section className="graph-panel" aria-label="Reference map">
      <div className="graph-stage">
        <GraphCanvas controlsRef={controls} themeKey={themeKey} />
        <GraphToolbar controls={controls} legendOpen={legendOpen} onToggleLegend={() => setLegendOpen((v) => !v)} tab={tab} onTab={onTab} />
        {legendOpen && !empty && <GraphLegend />}
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
