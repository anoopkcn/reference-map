import { memo, useEffect, useState, type ReactNode } from 'react';
import { displayLookup } from '../lib/ids';
import { formatCount } from '../lib/format';
import { useAppStore } from '../store';
import { usePaper } from '../store/selectors';
import type { ListKind, Paper, PaperId, Seed } from '../types';
import { Icon } from './icons';
import { PaperActions } from './PaperActions';
import { PaperList } from './PaperList';
import { PaperMeta } from './PaperMeta';

/** A seed paper: full metadata, abstract on demand, lazy cited/citing lists. */
export const IndexCard = memo(function IndexCard({ seed }: { seed: Seed }) {
  const paper = usePaper(seed.paperId);
  const removeSeed = useAppStore((s) => s.removeSeed);
  const refreshSeed = useAppStore((s) => s.refreshSeed);
  const addSeeds = useAppStore((s) => s.addSeeds);
  const [refreshing, setRefreshing] = useState(false);
  const selected = useAppStore((s) => !!seed.paperId && s.selectedId === seed.paperId);
  const select = useAppStore((s) => s.select);
  const hover = useAppStore((s) => s.hover);
  const [open, setOpen] = useState<ListKind | null>(null);

  if (seed.status !== 'ready' || !paper) {
    return (
      <article className={`card seed-card ${seed.status}`}>
        <div className="row">
          {seed.status === 'resolving' ? <span className="spinner" /> : <Icon name="alert" className="error-text" />}
          <span className="mono" title={seed.lookup}>{displayLookup(seed.lookup)}</span>
          <span className="header-spacer" />
          {seed.status === 'error' && (
            <button className="btn ghost sm" onClick={() => { removeSeed(seed.lookup); void addSeeds([seed.lookup]); }} title="Retry">
              <Icon name="refresh" /> Retry
            </button>
          )}
          <button className="btn ghost icon sm" onClick={() => removeSeed(seed.lookup)} aria-label="Remove"><Icon name="close" /></button>
        </div>
        {seed.status === 'error' && <div className="error-text small">{seed.error}</div>}
        {seed.status === 'resolving' && <div className="faint small">Looking up on Semantic Scholar…</div>}
      </article>
    );
  }

  const toggle = (kind: ListKind) => setOpen((cur) => (cur === kind ? null : kind));

  return (
    <article
      className={`card seed-card ready ${selected ? 'selected' : ''}`}
      onMouseEnter={() => hover(paper.paperId)}
      onMouseLeave={() => hover(null)}
    >
      <div className="card-body" onClick={() => select(selected ? null : paper.paperId)}>
        <div className="card-head">
          <div className="seed-badge" title="Seed paper">
            <span className="dot seed" /> Seed
            {seed.lookup !== paper.paperId && <span className="mono faint"> · {displayLookup(seed.lookup)}</span>}
          </div>
          <div className="card-head-actions">
            <button
              className="btn icon sm refresh-seed"
              onClick={(e) => {
                e.stopPropagation();
                if (refreshing) return;
                setRefreshing(true);
                void refreshSeed(seed.lookup).finally(() => setRefreshing(false));
              }}
              disabled={refreshing}
              title="Re-fetch this paper's details, references and citations from Semantic Scholar"
              aria-label="Refresh paper data"
            >
              {refreshing ? <span className="spinner" /> : <Icon name="refresh" />}
            </button>
            <button
              className="btn icon sm remove-seed"
              onClick={(e) => {
                e.stopPropagation();
                removeSeed(seed.lookup);
              }}
              title="Remove this paper from the sidebar and the map"
              aria-label="Remove from sidebar and map"
            >
              <Icon name="minus" />
            </button>
          </div>
        </div>
        <PaperMeta paper={paper} variant="full" />
        <Abstract
          paperId={paper.paperId}
          extra={
            paper.influentialCitationCount > 0 ? (
              <span className="stat" title="Influential citations (Semantic Scholar)">
                <Icon name="target" size={13} /> {formatCount(paper.influentialCitationCount)} influential
              </span>
            ) : null
          }
        />
        <PaperActions paper={paper} hideWhenExpanded />
      </div>
      <div className="list-toggles">
        <ToggleButton kind="refs" count={paper.referenceCount} open={open === 'refs'} onClick={() => toggle('refs')} />
        <ToggleButton kind="cites" count={paper.citationCount} open={open === 'cites'} onClick={() => toggle('cites')} />
      </div>
      {open && <PaperList ownerId={paper.paperId} kind={open} />}
    </article>
  );
});

function ToggleButton({ kind, count, open, onClick }: { kind: ListKind; count: number; open: boolean; onClick: () => void }) {
  const label = kind === 'refs' ? 'References' : 'Citations';
  return (
    <button className={`toggle ${open ? 'active' : ''}`} onClick={onClick} disabled={count === 0} aria-expanded={open} title={kind === 'refs' ? 'Papers this paper cites' : 'Papers citing this paper'}>
      <Icon name={kind === 'refs' ? 'list' : 'quote'} size={13} />
      {label} <strong>{formatCount(count)}</strong>
      <Icon name="chevronDown" size={13} className={`chev ${open ? 'open' : ''}`} />
    </button>
  );
}

/** Collapsed abstract; fetches full details on first expand. `extra` renders on the toggle line, right-aligned. */
export function Abstract({ paperId, extra }: { paperId: PaperId; extra?: ReactNode }) {
  const paper = usePaper(paperId) as Paper | undefined;
  const ensureDetail = useAppStore((s) => s.ensureDetail);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (open && paper && paper.detailLevel !== 'full') {
      setLoading(true);
      void ensureDetail(paperId).finally(() => setLoading(false));
    }
  }, [open, paper, paperId, ensureDetail]);
  if (!paper) return null;
  return (
    <div className="abstract" onClick={(e) => e.stopPropagation()}>
      <div className="abstract-toggle-row">
        <button className="linkish" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <Icon name="chevronRight" size={12} className={`chev ${open ? 'open' : ''}`} /> {open ? 'Hide abstract' : 'Show abstract'}
        </button>
        {extra}
      </div>
      {open && (
        <div className="abstract-text">
          {loading && paper.abstract === undefined ? (
            <span className="muted"><span className="spinner" /> Loading…</span>
          ) : paper.abstract ? (
            paper.abstract
          ) : (
            <span className="muted">No abstract available.</span>
          )}
        </div>
      )}
    </div>
  );
}
