import { useCallback, useMemo, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { parseInput } from '../lib/ids';
import { useAppStore } from '../store';
import { Icon } from './icons';

/** One box for everything: DOI, arXiv id, URL, Semantic Scholar id — or a title/keyword search. */
export function SeedInput() {
  const addSeeds = useAppStore((s) => s.addSeeds);
  const searchPapers = useAppStore((s) => s.searchPapers);
  const pushToast = useAppStore((s) => s.pushToast);
  const [value, setValue] = useState('');

  const parsed = useMemo(() => parseInput(value), [value]);

  const submit = useCallback(
    (text: string) => {
      const p = parseInput(text);
      if (p.kind === 'empty') return;
      if (p.kind === 'ids') {
        void addSeeds(p.lookups);
        if (p.rejected.length) pushToast(`Ignored ${p.rejected.length} unrecognised line${p.rejected.length > 1 ? 's' : ''}`, 'error');
      } else {
        void searchPapers(p.query);
      }
      setValue('');
    },
    [addSeeds, searchPapers, pushToast],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit(value);
    }
  };

  // Multi-line pastes (a list of DOIs) are handled immediately.
  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text');
    if (/[\n\r]/.test(text)) {
      const p = parseInput(text);
      if (p.kind === 'ids' && p.lookups.length > 1) {
        e.preventDefault();
        submit(text);
      }
    }
  };

  return (
    <div className="seed-input">
      <div className="search-box large">
        <Icon name={parsed.kind === 'search' ? 'search' : 'plus'} />
        <input
          className="input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder="DOI, arXiv id, URL, or paper title…"
          aria-label="Add a paper by identifier or search by title"
          dir="auto"
          autoFocus
          spellCheck={false}
        />
        <button
          className="btn primary sm go"
          onClick={() => submit(value)}
          disabled={parsed.kind === 'empty'}
          title={parsed.kind === 'search' ? 'Search Semantic Scholar by title' : parsed.kind === 'ids' ? `Add ${parsed.lookups.length} paper${parsed.lookups.length > 1 ? 's' : ''}` : 'Paste a DOI, arXiv id, URL or Semantic Scholar link — or type a title to search'}
        >
          {parsed.kind === 'search' ? 'Search' : 'Add'}
        </button>
      </div>
    </div>
  );
}
