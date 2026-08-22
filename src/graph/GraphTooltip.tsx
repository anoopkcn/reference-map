import { forwardRef } from 'react';
import { authorsLine, formatCount, venueLine } from '../lib/format';
import { usePaper } from '../store/selectors';
import type { PaperId } from '../types';

export const GraphTooltip = forwardRef<HTMLDivElement, { id: PaperId | null }>(function GraphTooltip({ id }, ref) {
  const paper = usePaper(id);
  return (
    <div ref={ref} className={`graph-tooltip ${paper ? 'show' : ''}`} role="tooltip" aria-hidden={!paper}>
      {paper && (
        <>
          <div className="tt-title" dir="auto">{paper.title}</div>
          <div className="tt-meta" dir="auto">{authorsLine(paper.authors, 3)}{paper.year ? ` · ${paper.year}` : ''}</div>
          {venueLine(paper) && <div className="tt-meta faint" dir="auto">{venueLine(paper)}</div>}
          <div className="tt-counts">{formatCount(paper.citationCount)} citations · {formatCount(paper.referenceCount)} references</div>
          <div className="tt-hint">click · details &nbsp; double-click · expand &nbsp; drag · pin</div>
        </>
      )}
    </div>
  );
});
