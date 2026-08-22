import { memo, type CSSProperties } from 'react';
import { useAppStore } from '../store';
import { usePaper } from '../store/selectors';
import type { PaperId } from '../types';
import { PaperActions } from './PaperActions';
import { Counts, PaperMeta } from './PaperMeta';

export const ROW_HEIGHT = 90;

/** Compact list row. Memoised; subscribes only to its own paper + selection flag. */
export const PaperRow = memo(function PaperRow({ id, style }: { id: PaperId; style?: CSSProperties }) {
  const paper = usePaper(id);
  const selected = useAppStore((s) => s.selectedId === id);
  const inGraph = useAppStore((s) => (s.graphVersion, s.graph.hasNode(id)));
  const select = useAppStore((s) => s.select);
  const hover = useAppStore((s) => s.hover);
  if (!paper) return <div className="row-item placeholder" style={style} />;
  return (
    <div
      className={`row-item ${selected ? 'selected' : ''} ${inGraph ? 'in-graph' : ''}`}
      style={style}
      onClick={() => select(selected ? null : id)}
      onMouseEnter={() => inGraph && hover(id)}
      onMouseLeave={() => inGraph && hover(null)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          select(selected ? null : id);
        }
      }}
    >
      <div className="row-main">
        <PaperMeta paper={paper} variant="compact" />
        <Counts paper={paper} compact />
      </div>
      <PaperActions paper={paper} compact />
    </div>
  );
});
