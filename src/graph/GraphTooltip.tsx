import { forwardRef, useMemo } from 'react';
import { authorsLine, formatCount, venueLine } from '../lib/format';
import { useAppStore } from '../store';
import { usePaper } from '../store/selectors';
import type { PaperId } from '../types';
import { orderSeeds } from './confluence';

interface SeedLinkRow {
  slot: number;
  label: string;
  dir: string;
}

/** Which seeds this paper is directly linked to, in anchor order (matches the canvas colours). */
function seedLinkRows(id: PaperId): SeedLinkRow[] {
  const s = useAppStore.getState();
  const g = s.graph;
  const ordered = orderSeeds([...g.seeds], (sid) => s.lists.get(sid)?.refs?.ids);
  const rows: SeedLinkRow[] = [];
  ordered.forEach((sid, slot) => {
    if (sid === id) return;
    const cites = g.outgoing.get(id)?.has(sid) ?? false; // this paper cites the seed
    const citedBy = g.outgoing.get(sid)?.has(id) ?? false; // the seed cites this paper
    if (!cites && !citedBy) return;
    const label = g.getNode(sid)?.label ?? '';
    rows.push({ slot, label, dir: cites && citedBy ? 'cites & cited by' : cites ? 'cites' : 'cited by' });
  });
  return rows;
}

export const GraphTooltip = forwardRef<HTMLDivElement, { id: PaperId | null }>(function GraphTooltip({ id }, ref) {
  const paper = usePaper(id);
  const layoutMode = useAppStore((s) => s.settings.layoutMode);
  const graphVersion = useAppStore((s) => s.graphVersion);
  const seedLinks = useMemo(
    // seed-coloured modes (confluence, timeline) decompose the paper's seed links
    () => (id && layoutMode !== 'force' ? seedLinkRows(id) : null),
    // graphVersion invalidates the memo when edges/seeds change
    [id, layoutMode, graphVersion],
  );
  return (
    <div ref={ref} className={`graph-tooltip ${paper ? 'show' : ''}`} role="tooltip" aria-hidden={!paper}>
      {paper && (
        <>
          <div className="tt-title" dir="auto">{paper.title}</div>
          <div className="tt-meta" dir="auto">{authorsLine(paper.authors, 3)}{paper.year ? ` · ${paper.year}` : ''}</div>
          {venueLine(paper) && <div className="tt-meta faint" dir="auto">{venueLine(paper)}</div>}
          <div className="tt-counts">{formatCount(paper.citationCount)} citations · {formatCount(paper.referenceCount)} references</div>
          {seedLinks && seedLinks.length > 0 && (
            <div className="tt-seeds">
              {seedLinks.map((r) => (
                <div className="tt-seed-row" key={r.slot}>
                  <span className="tt-seed-dot" style={{ background: `var(--seed-${(r.slot % 8) + 1})` }} />
                  <span>{r.dir} {r.label}</span>
                </div>
              ))}
            </div>
          )}
          <div className="tt-hint">click · details &nbsp; double-click · expand &nbsp; drag · pin</div>
        </>
      )}
    </div>
  );
});
