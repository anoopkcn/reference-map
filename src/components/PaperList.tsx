import { useEffect, useMemo, useRef, useState } from 'react';
import { useWindowedRows } from '../hooks/useWindowedRows';
import { filterIds, sortIds } from '../lib/sort';
import { formatCount } from '../lib/format';
import { useAppStore } from '../store';
import { useListState } from '../store/selectors';
import type { ListKind, PaperId, SortDir, SortKey } from '../types';
import { Icon } from './icons';
import { PaperRow, ROW_HEIGHT } from './PaperRow';
import { SortControl } from './SortControl';

/** References / citations of one paper: lazy-loaded, filterable, sortable, windowed. */
export function PaperList({ ownerId, kind }: { ownerId: PaperId; kind: ListKind }) {
  const list = useListState(ownerId, kind);
  const loadList = useAppStore((s) => s.loadList);
  const papers = useAppStore((s) => s.papers);
  const defaults = useAppStore((s) => s.settings);
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>(defaults.sortKey);
  const [sortDir, setSortDir] = useState<SortDir>(defaults.sortDir);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadList(ownerId, kind);
  }, [ownerId, kind, loadList]);

  const ids = list?.ids ?? EMPTY;
  const visibleIds = useMemo(() => sortIds(filterIds(ids, papers, query), papers, sortKey, sortDir), [ids, papers, query, sortKey, sortDir]);
  const win = useWindowedRows(scrollRef, visibleIds.length, ROW_HEIGHT);

  const label = kind === 'refs' ? 'references' : 'citations';
  const total = list?.total ?? null;
  const capped = total !== null && ids.length < total;

  return (
    <div className="paper-list">
      <div className="list-head">
        <div className="search-box">
          <Icon name="search" />
          <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Filter ${label}…`} aria-label={`Filter ${label}`} />
          {query && (
            <button className="btn ghost icon sm clear" onClick={() => setQuery('')} aria-label="Clear filter">
              <Icon name="close" />
            </button>
          )}
        </div>
        <SortControl sortKey={sortKey} sortDir={sortDir} onChange={(k, d) => { setSortKey(k); setSortDir(d); }} />
      </div>
      <div className="list-status muted">
        {list?.status === 'loading' && (<><span className="spinner" /> Loading {label}…</>)}
        {list?.status === 'error' && (
          <span className="error-text"><Icon name="alert" size={13} /> {list.error} <button className="linkish" onClick={() => void loadList(ownerId, kind)}>Retry</button></span>
        )}
        {list?.status === 'ready' && (
          <span>
            {query ? `${visibleIds.length} of ${ids.length}` : formatCount(ids.length)} {label}
            {capped && <span title={`Semantic Scholar reports ${total}; showing the first ${ids.length} (raise the limit in settings)`}> · of {formatCount(total)}</span>}
          </span>
        )}
      </div>
      {list?.status === 'ready' && ids.length > 0 && (
        <div className="list-scroll" ref={scrollRef}>
          <div style={{ height: win.padTop }} />
          {visibleIds.slice(win.start, win.end).map((id) => (
            <PaperRow key={id} id={id} style={{ height: ROW_HEIGHT }} />
          ))}
          <div style={{ height: win.padBottom }} />
        </div>
      )}
      {list?.status === 'ready' && ids.length === 0 && <div className="empty-note muted">No {label} available.</div>}
    </div>
  );
}

const EMPTY: PaperId[] = [];
