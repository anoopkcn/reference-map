import { memo, useState } from 'react';
import { authorsLine, formatCount, pubTypeLabel, s2AuthorUrl, s2PaperUrl, surname, venueLine } from '../lib/format';
import type { Paper } from '../types';
import { Icon } from './icons';

const MAX_AUTHORS = 6;

/** Title / authors / year · venue / type chips. `compact` is the one-line form for list rows. */
export const PaperMeta = memo(function PaperMeta({ paper, variant }: { paper: Paper; variant: 'full' | 'compact' }) {
  if (variant === 'compact') {
    const first = paper.authors[0];
    const who = first ? surname(first.name) + (paper.authors.length > 1 ? ' et al.' : '') : '';
    const venue = venueLine(paper);
    return (
      <div className="meta compact">
        <div className="title" title={paper.title}>{paper.title}</div>
        <div className="metaline">
          {who && <span>{who}</span>}
          {paper.year && <span>{paper.year}</span>}
          {venue && <span className="venue" title={venue}>{venue}</span>}
        </div>
      </div>
    );
  }
  const venue = venueLine(paper);
  return (
    <div className="meta full">
      <h3 className="title">
        <a href={s2PaperUrl(paper.paperId)} target="_blank" rel="noopener noreferrer" title="Open on Semantic Scholar">
          {paper.title}
        </a>
      </h3>
      <Authors paper={paper} />
      <div className="metaline">
        {paper.year && <span className="year">{paper.year}</span>}
        {venue && <span className="venue">{venue}</span>}
        {paper.publicationTypes.map((t) => (
          <span key={t} className="chip">{pubTypeLabel(t)}</span>
        ))}
      </div>
    </div>
  );
});

function Authors({ paper }: { paper: Paper }) {
  const [all, setAll] = useState(false);
  if (paper.authors.length === 0) return <div className="authors muted">Unknown authors</div>;
  const shown = all ? paper.authors : paper.authors.slice(0, MAX_AUTHORS);
  const extra = paper.authors.length - shown.length;
  return (
    <div className="authors" title={authorsLine(paper.authors)}>
      {shown.map((a, i) => (
        <span key={`${a.authorId ?? a.name}-${i}`}>
          {a.authorId ? (
            <a href={s2AuthorUrl(a.authorId)} target="_blank" rel="noopener noreferrer">{a.name}</a>
          ) : (
            <span>{a.name}</span>
          )}
          {i < shown.length - 1 ? ', ' : ''}
        </span>
      ))}
      {extra > 0 && (
        <button className="linkish" onClick={() => setAll(true)}>, +{extra} more</button>
      )}
      {all && paper.authors.length > MAX_AUTHORS && (
        <button className="linkish" onClick={() => setAll(false)}> less</button>
      )}
    </div>
  );
}

/** Small "n references · n citations · n influential" strip. */
export function Counts({ paper, compact = false }: { paper: Paper; compact?: boolean }) {
  return (
    <div className={`counts ${compact ? 'compact' : ''}`}>
      <span title="References (papers it cites)"><Icon name="list" size={12} /> {formatCount(paper.referenceCount)}</span>
      <span title="Citations (papers citing it)"><Icon name="quote" size={12} /> {formatCount(paper.citationCount)}</span>
      {paper.influentialCitationCount > 0 && (
        <span title="Influential citations"><Icon name="target" size={12} /> {formatCount(paper.influentialCitationCount)}</span>
      )}
    </div>
  );
}
