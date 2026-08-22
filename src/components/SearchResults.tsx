import { useAppStore } from '../store';
import { usePaper } from '../store/selectors';
import type { PaperId } from '../types';
import { Icon } from './icons';
import { Counts, PaperMeta } from './PaperMeta';

export function SearchResults() {
  const search = useAppStore((s) => s.search);
  const clearSearch = useAppStore((s) => s.clearSearch);
  if (!search) return null;
  return (
    <section className="search-results" aria-label="Search results">
      <div className="section-head">
        <span>
          {search.status === 'loading' && (<><span className="spinner" /> Searching “{search.query}”…</>)}
          {search.status === 'ready' && (<>Results for “{search.query}”{search.total !== null && <span className="muted"> · {search.total.toLocaleString()} matches</span>}</>)}
          {search.status === 'error' && <span className="error-text"><Icon name="alert" size={13} /> {search.error}</span>}
        </span>
        <button className="btn ghost icon sm" onClick={clearSearch} aria-label="Close search results"><Icon name="close" /></button>
      </div>
      {search.status === 'ready' && search.ids.length === 0 && <div className="empty-note muted">Nothing found. Try different words.</div>}
      {search.ids.map((id) => (
        <ResultRow key={id} id={id} />
      ))}
    </section>
  );
}

function ResultRow({ id }: { id: PaperId }) {
  const paper = usePaper(id);
  const addSeeds = useAppStore((s) => s.addSeeds);
  const isSeed = useAppStore((s) => s.seeds.some((x) => x.paperId === id));
  if (!paper) return null;
  return (
    <div className="result-row">
      <div className="row-main">
        <PaperMeta paper={paper} variant="compact" />
        <Counts paper={paper} compact />
      </div>
      <button className={`btn sm ${isSeed ? '' : 'primary'}`} onClick={() => void addSeeds([id])} disabled={isSeed} title="Add as seed paper">
        {isSeed ? <><Icon name="check" /> Added</> : <><Icon name="plus" /> Add</>}
      </button>
    </div>
  );
}
