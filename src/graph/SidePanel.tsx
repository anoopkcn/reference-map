import { useEffect, useState } from 'react';
import { Abstract } from '../components/IndexCard';
import { Icon } from '../components/icons';
import { PaperActions } from '../components/PaperActions';
import { Counts, PaperMeta } from '../components/PaperMeta';
import { useAppStore } from '../store';
import { usePaper } from '../store/selectors';
import { NodeRole } from '../types';

const ROLE_LABEL: Record<NodeRole, string> = { 0: 'Seed', 1: 'Reference', 2: 'Citation', 3: 'Reference & citation', 4: 'Not connected' };
const ROLE_CLASS: Record<NodeRole, string> = { 0: 'seed', 1: 'cited', 2: 'citing', 3: 'both', 4: 'isolated' };

/** Details of the selected node. */
export function SidePanel() {
  const selectedId = useAppStore((s) => s.selectedId);
  const paper = usePaper(selectedId);
  const select = useAppStore((s) => s.select);
  const ensureDetail = useAppStore((s) => s.ensureDetail);
  const node = useAppStore((s) => (s.graphVersion, selectedId ? s.graph.getNode(selectedId) : undefined));
  // Primitive selectors only: returning a fresh object from a selector would re-render forever.
  const cites = useAppStore((s) => (s.graphVersion, selectedId ? s.graph.outgoing.get(selectedId)?.size ?? 0 : 0));
  const citedBy = useAppStore((s) => (s.graphVersion, selectedId ? s.graph.incoming.get(selectedId)?.size ?? 0 : 0));

  // Open slightly after the double-click window so a double-click on a node is not intercepted by the panel.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!selectedId) {
      setShown(false);
      return;
    }
    void ensureDetail(selectedId);
    const t = setTimeout(() => setShown(true), 420);
    return () => clearTimeout(t);
  }, [selectedId, ensureDetail]);

  if (!selectedId || !paper || !shown) return null;
  return (
    <aside className="side-panel" aria-label="Selected paper">
      <div className="side-head">
        {node ? (
          <span className={`role-chip ${ROLE_CLASS[node.role]}`}><span className={`dot ${ROLE_CLASS[node.role]}`} /> {ROLE_LABEL[node.role]}</span>
        ) : (
          <span className="role-chip"><Icon name="info" size={12} /> Not in the map</span>
        )}
        <span className="header-spacer" />
        <button className="btn ghost icon sm" onClick={() => select(null)} aria-label="Close"><Icon name="close" /></button>
      </div>
      <div className="side-body">
        <PaperMeta paper={paper} variant="full" />
        <Counts paper={paper} />
        {node && (
          <div className="faint small">In this map: {cites} reference{cites === 1 ? '' : 's'} · {citedBy} citation{citedBy === 1 ? '' : 's'}{node.pinned ? ' · pinned' : ''}</div>
        )}
        <Abstract paperId={paper.paperId} />
        <PaperActions paper={paper} />
      </div>
    </aside>
  );
}
