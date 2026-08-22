import { useCallback, useState } from 'react';
import { copyText } from '../lib/clipboard';
import { generateBibtex } from '../lib/bibtex';
import { doiUrl, paperUrl, paperUrlLabel, pdfUrl, plainCitation } from '../lib/format';
import { useAppStore } from '../store';
import { useIsExpanding, useIsSeed } from '../store/selectors';
import type { Paper } from '../types';
import { Icon } from './icons';

interface Props {
  paper: Paper;
  /** Icon-only buttons for rows. */
  compact?: boolean;
  onRemove?: () => void;
  /** Hide the Expand button once the paper is expanded (seed cards: auto-expanded, so it is redundant). */
  hideWhenExpanded?: boolean;
}

/** Copy / open / graph actions for one paper. */
export function PaperActions({ paper, compact = false, onRemove, hideWhenExpanded = false }: Props) {
  const ensureDetail = useAppStore((s) => s.ensureDetail);
  const pushToast = useAppStore((s) => s.pushToast);
  const expandNode = useAppStore((s) => s.expandNode);
  const addSeeds = useAppStore((s) => s.addSeeds);
  const graphHas = useAppStore((s) => (s.graphVersion, s.graph.hasNode(paper.paperId)));
  const expanded = useAppStore((s) => (s.graphVersion, s.graph.getNode(paper.paperId)?.expanded ?? false));
  const expanding = useIsExpanding(paper.paperId);
  const isSeed = useIsSeed(paper.paperId);
  const [busy, setBusy] = useState<string | null>(null);

  const copy = useCallback(
    async (what: 'bibtex' | 'cite' | 'doi') => {
      setBusy(what);
      try {
        let text: string | null = null;
        if (what === 'bibtex') {
          const p = (await ensureDetail(paper.paperId)) ?? paper;
          text = p.bibtex || generateBibtex(p);
        } else if (what === 'cite') text = plainCitation(paper);
        else text = doiUrl(paper);
        if (text && (await copyText(text))) pushToast('Copied to clipboard');
        else if (text) pushToast('Could not copy', 'error');
      } finally {
        setBusy(null);
      }
    },
    [ensureDetail, paper, pushToast],
  );

  const pdf = pdfUrl(paper);
  const doi = doiUrl(paper);
  const size = compact ? 'btn ghost icon sm' : 'btn sm';

  return (
    <div className={`actions ${compact ? 'compact' : ''}`} onClick={(e) => e.stopPropagation()}>
      {!compact && (
        <>
          <button className={size} onClick={() => copy('bibtex')} disabled={busy === 'bibtex'} title="Copy BibTeX">
            <Icon name="copy" /> BibTeX
          </button>
          <button className={size} onClick={() => copy('cite')} title="Copy plain-text citation">
            <Icon name="quote" /> Cite
          </button>
          {doi && (
            <button className={size} onClick={() => copy('doi')} title={`Copy ${doi}`}>
              <Icon name="link" /> DOI
            </button>
          )}
        </>
      )}
      {pdf && (
        <a className={size} href={pdf} target="_blank" rel="noopener noreferrer" title="Open access PDF">
          <Icon name="file" />{!compact && ' PDF'}
        </a>
      )}
      {compact && paperUrl(paper) && (
        <a className={size} href={paperUrl(paper)!} target="_blank" rel="noopener noreferrer" title={paperUrlLabel(paper)}>
          <Icon name="external" />
        </a>
      )}
      {!(hideWhenExpanded && expanded && !expanding) && (
        <button
          className={`${size} ${expanded ? 'active' : ''}`}
          onClick={() => void expandNode(paper.paperId)}
          disabled={expanding}
          title={expanded ? 'Connections are loaded in the map' : graphHas ? 'Load this paper’s connections into the map' : 'Add to the map and load its connections'}
        >
          {expanding ? <span className="spinner" /> : <Icon name="graph" />}
          {!compact && (expanded ? ' Expanded' : expanding ? ' Expanding…' : ' Expand')}
        </button>
      )}
      {!isSeed && (
        <button className={size} onClick={() => void addSeeds([paper.paperId])} title="Add as a seed paper">
          <Icon name="plus" />{!compact && ' Seed'}
        </button>
      )}
      {onRemove && (
        <button className={`${size} danger`} onClick={onRemove} title="Remove this seed">
          <Icon name="trash" />{!compact && ' Remove'}
        </button>
      )}
    </div>
  );
}
