import { useState } from 'react';
import type { ZoteroItem } from '../api/zotero';
import { useAppStore } from '../store';
import { usePaper } from '../store/selectors';
import { PROVIDER_LABEL, type PaperId } from '../types';
import { Icon } from './icons';
import { Counts, PaperMeta } from './PaperMeta';

export function SearchResults() {
  const search = useAppStore((s) => s.search);
  const clearSearch = useAppStore((s) => s.clearSearch);
  const hasKey = useAppStore((s) => !!s.settings.zoteroApiKey);
  const source = useAppStore((s) => s.zotero.searchSource);
  if (!search) return null;
  const z = search.zotero;
  return (
    <section className="search-results" aria-label="Search results">
      <div className="section-head">
        <span>Results for “{search.query}”</span>
        <button className="btn ghost icon sm" onClick={clearSearch} aria-label="Close search results"><Icon name="close" /></button>
      </div>

      {z && (z.status !== 'error' || hasKey) && (
        <>
          <div className="subsection-head">
            <Icon name="bookmark" size={12} /> Your Zotero library
            {z.status === 'ready' && source && <span className="muted"> · {source === 'local' ? 'from this computer' : 'via zotero.org'}</span>}
          </div>
          {z.status === 'loading' && z.items.length === 0 && <div className="empty-note muted"><span className="spinner" /> Searching…</div>}
          {z.status === 'error' && <div className="empty-note"><span className="error-text"><Icon name="alert" size={13} /> {z.error}</span></div>}
          {z.items.map((item) => <ZoteroRow key={item.key} item={item} />)}
          {z.status === 'ready' && z.items.length === 0 && <div className="empty-note muted">No matches in your library.</div>}
        </>
      )}

      {search.status === 'idle' ? (
        <div className="empty-note muted">Press Enter to also search Semantic Scholar / OpenAlex.</div>
      ) : (
        <>
          <div className="subsection-head">
            <Icon name="search" size={12} /> {search.provider ? PROVIDER_LABEL[search.provider] : 'Web search'}
            {search.status === 'ready' && search.total !== null && <span className="muted"> · {search.total.toLocaleString()} matches</span>}
          </div>
          {search.status === 'loading' && <div className="empty-note muted"><span className="spinner" /> Searching…</div>}
          {search.status === 'error' && <div className="empty-note"><span className="error-text"><Icon name="alert" size={13} /> {search.error}</span></div>}
          {search.status === 'ready' && search.ids.length === 0 && <div className="empty-note muted">Nothing found. Try different words.</div>}
          {search.status === 'ready' && search.ids.map((id) => <ResultRow key={id} id={id} />)}
        </>
      )}
    </section>
  );
}

function ZoteroRow({ item }: { item: ZoteroItem }) {
  const seedFromZoteroItem = useAppStore((s) => s.seedFromZoteroItem);
  const [busy, setBusy] = useState(false);
  const year = item.meta?.parsedDate?.slice(0, 4) ?? '';
  const line = [item.meta?.creatorSummary, year, item.data.itemType].filter(Boolean).join(' · ');
  const pick = async () => {
    setBusy(true);
    try {
      await seedFromZoteroItem(item);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="result-row">
      <div className="row-main">
        <div className="picker-title" dir="auto">{item.data.title || '(untitled)'}</div>
        {line && <div className="faint small">{line}</div>}
      </div>
      <button className="btn sm primary" onClick={() => void pick()} disabled={busy} title="Add as seed paper">
        {busy ? <span className="spinner" /> : <><Icon name="plus" /> Add</>}
      </button>
    </div>
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
