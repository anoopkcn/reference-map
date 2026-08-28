import { useCallback, useEffect, useState } from 'react';
import { copyText } from '../lib/clipboard';
import { generateBibtex } from '../lib/bibtex';
import { doiUrl, paperUrl, paperUrlLabel, pdfUrl, plainCitation } from '../lib/format';
import { useAppStore } from '../store';
import { useIsExpanding } from '../store/selectors';
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
  const zoteroSave = useAppStore((s) => s.zoteroSave);
  const zoteroOpenLocal = useAppStore((s) => s.zoteroOpenLocal);
  const zoteroCheckLibrary = useAppStore((s) => s.zoteroCheckLibrary);
  const zoteroEnabled = useAppStore((s) => s.settings.zoteroEnabled && (!!s.settings.zoteroApiKey || s.zotero.localAvailable));
  const zoteroLocalUp = useAppStore((s) => s.zotero.localAvailable);
  const zoteroSaved = useAppStore((s) => !!s.zotero.savedKeys[paper.paperId]);

  // Pre-resolve the button state for papers already in the library (cheap local-API check).
  useEffect(() => {
    if (!compact && zoteroLocalUp) void zoteroCheckLibrary(paper.paperId);
  }, [compact, zoteroLocalUp, paper.paperId, zoteroCheckLibrary]);
  const expanded = useAppStore((s) => (s.graphVersion, s.graph.getNode(paper.paperId)?.expanded ?? false));
  const expanding = useIsExpanding(paper.paperId);
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
          {zoteroEnabled && (
            <button
              className={size}
              onClick={async () => {
                if (zoteroSaved) {
                  void zoteroOpenLocal(paper.paperId);
                  return;
                }
                setBusy('zotero');
                try {
                  await zoteroSave(paper.paperId);
                } finally {
                  setBusy(null);
                }
              }}
              disabled={busy === 'zotero'}
              title={zoteroSaved ? 'Show this item in your Zotero app' : 'Save this paper to your Zotero library'}
            >
              {zoteroSaved ? <Icon name="check" /> : busy === 'zotero' ? <span className="spinner" /> : <Icon name="bookmark" />}
              {zoteroSaved ? ' In Zotero' : ' Zotero'}
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
          title={expanded ? 'Connections are loaded in the map' : 'Load this paper’s connections into the map and pin it to the sidebar'}
        >
          {expanding ? <span className="spinner" /> : <Icon name="graph" />}
          {!compact && (expanded ? ' Expanded' : expanding ? ' Expanding…' : ' Expand')}
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
