import type { RefObject } from 'react';
import { Tabs, type Tab } from '../App';
import { Icon } from '../components/icons';
import { useAppStore } from '../store';
import type { LabelMode } from '../types';
import type { GraphControls } from './GraphCanvas';

const LABEL_CYCLE: LabelMode[] = ['seeds', 'auto', 'all'];
const LABEL_TITLE: Record<LabelMode, string> = { seeds: 'Labels: seeds only', auto: 'Labels: auto (zoom in for more)', all: 'Labels: all' };

export function GraphToolbar({
  controls,
  legendOpen,
  onToggleLegend,
  tab,
  onTab,
}: {
  controls: RefObject<GraphControls | null>;
  legendOpen: boolean;
  onToggleLegend: () => void;
  tab: Tab;
  onTab: (t: Tab) => void;
}) {
  const nodes = useAppStore((s) => (s.graphVersion, s.graph.nodeCount));
  const edges = useAppStore((s) => (s.graphVersion, s.graph.edgeCount));
  const pinned = useAppStore((s) => (s.graphVersion, countPinned(s.graph)));
  const expanding = useAppStore((s) => s.expanding.size);
  const labelMode = useAppStore((s) => s.settings.labelMode);
  const update = useAppStore((s) => s.updateSettings);
  const nextLabel = LABEL_CYCLE[(LABEL_CYCLE.indexOf(labelMode) + 1) % LABEL_CYCLE.length]!;
  return (
    <div className="graph-toolbar">
      <div className="tool-group mobile-tabs">
        <Tabs tab={tab} onTab={onTab} />
      </div>
      <div className="tool-group">
        <button className="btn icon" onClick={() => controls.current?.fit()} title="Fit map to view" aria-label="Fit to view" disabled={nodes === 0}><Icon name="fit" /></button>
        <button className="btn icon" onClick={() => controls.current?.reheat()} title="Re-run layout" aria-label="Re-run layout" disabled={nodes === 0}><Icon name="refresh" /></button>
        <button className="btn icon" onClick={() => controls.current?.unpinAll()} title="Unpin all nodes" aria-label="Unpin all nodes" disabled={pinned === 0}><Icon name="unpin" /></button>
        <button className="btn icon" onClick={() => update({ labelMode: nextLabel })} title={LABEL_TITLE[labelMode]} aria-label={LABEL_TITLE[labelMode]}>
          <Icon name="tag" /><span className="label-mode">{labelMode === 'seeds' ? 'S' : labelMode === 'auto' ? 'A' : '∞'}</span>
        </button>
        <button className={`btn icon ${legendOpen ? 'active' : ''}`} onClick={onToggleLegend} title="Legend" aria-label="Toggle legend"><Icon name="info" /></button>
      </div>
      {(nodes > 0 || expanding > 0) && (
        <div className="tool-group stats">
          {nodes > 0 && <span>{nodes.toLocaleString()} papers · {edges.toLocaleString()} connections</span>}
          {expanding > 0 && <span className="row"><span className="spinner" /> loading connections…</span>}
        </div>
      )}
    </div>
  );
}

function countPinned(g: { nodes: Map<string, { pinned: boolean }> }): number {
  let n = 0;
  for (const v of g.nodes.values()) if (v.pinned) n++;
  return n;
}
