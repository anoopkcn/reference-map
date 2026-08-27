import { useEffect, useMemo, useRef } from 'react';
import type { ZoteroCollection } from '../api/zotero';
import { useAppStore } from '../store';
import { Icon } from './icons';

/** Pick the Zotero collection new saves are filed into; the choice is remembered in settings. */
export function ZoteroCollectionDialog() {
  const open = useAppStore((s) => s.zotero.collectionDialogOpen);
  const cancel = useAppStore((s) => s.zoteroCancelCollection);
  const choose = useAppStore((s) => s.zoteroChooseCollection);
  const reload = useAppStore((s) => s.zoteroLoadCollections);
  const collections = useAppStore((s) => s.zotero.collections);
  const status = useAppStore((s) => s.zotero.collectionsStatus);
  const error = useAppStore((s) => s.zotero.collectionsError);
  const saving = useAppStore((s) => s.zotero.savePendingId !== null);
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);

  const rows = useMemo(() => orderCollections(collections ?? []), [collections]);

  return (
    <dialog ref={ref} className="dialog" onClose={cancel} onClick={(e) => { if (e.target === ref.current) cancel(); }}>
      <div className="dialog-body">
        <div className="dialog-head">
          <h2>Save to collection</h2>
          <button className="btn ghost icon" onClick={cancel} aria-label="Close"><Icon name="close" /></button>
        </div>
        <span className="faint small">
          {saving ? 'Where should this paper go? Papers you add to Zotero will be filed here — change it anytime in Settings.' : 'Papers you add to Zotero will be filed here.'}
        </span>
        <div className="picker-results">
          {status === 'loading' && <div className="empty-note muted"><span className="spinner" /> Loading collections…</div>}
          {status === 'error' && (
            <div className="empty-note">
              <span className="error-text"><Icon name="alert" size={13} /> {error}</span>{' '}
              <button className="btn sm" onClick={() => void reload()}>Retry</button>
            </div>
          )}
          {status === 'ready' && (
            <>
              <button className="collection-row" onClick={() => choose('', 'My Library')}>
                <Icon name="list" /> My Library <span className="faint small">(no collection)</span>
              </button>
              {rows.map((c) => (
                <button key={c.key} className="collection-row" style={{ paddingLeft: 10 + c.depth * 18 }} onClick={() => choose(c.key, c.name)}>
                  <Icon name="folder" /> {c.name}
                </button>
              ))}
            </>
          )}
        </div>
      </div>
    </dialog>
  );
}

/** Parents by name, children indented beneath them; collections whose parent is missing act as roots. */
function orderCollections(cols: ZoteroCollection[]): { key: string; name: string; depth: number }[] {
  const keys = new Set(cols.map((c) => c.key));
  const byParent = new Map<string | false, ZoteroCollection[]>();
  for (const c of cols) {
    const parent = c.parentCollection && keys.has(c.parentCollection) ? c.parentCollection : false;
    const list = byParent.get(parent) ?? [];
    list.push(c);
    byParent.set(parent, list);
  }
  const out: { key: string; name: string; depth: number }[] = [];
  const walk = (parent: string | false, depth: number): void => {
    const children = (byParent.get(parent) ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
    for (const c of children) {
      out.push({ key: c.key, name: c.name, depth });
      walk(c.key, depth + 1);
    }
  };
  walk(false, 0);
  return out;
}
