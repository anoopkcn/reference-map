import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store';
import { S2_LIMITS } from '../api/fields';
import type { LabelMode, Theme } from '../types';
import { Icon } from './icons';

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const settings = useAppStore((s) => s.settings);
  const update = useAppStore((s) => s.updateSettings);
  const clearCache = useAppStore((s) => s.clearCache);
  const [key, setKey] = useState(settings.apiKey);
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setKey(settings.apiKey);
      d.showModal();
    } else if (!open && d.open) d.close();
  }, [open, settings.apiKey]);

  const commitKey = () => {
    if (key.trim() !== settings.apiKey) update({ apiKey: key.trim() });
  };

  return (
    <dialog ref={ref} className="dialog" onClose={onClose} onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      <div className="dialog-body">
        <div className="dialog-head">
          <h2>Settings</h2>
          <button className="btn ghost icon" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
        </div>

        <label className="field">
          <span>Semantic Scholar API key <span className="faint">(optional)</span></span>
          <div className="row">
            <input className="input mono" type={showKey ? 'text' : 'password'} value={key} onChange={(e) => setKey(e.target.value)} onBlur={commitKey} placeholder="Paste your key for higher rate limits" autoComplete="off" spellCheck={false} />
            <button className="btn icon" onClick={() => setShowKey((v) => !v)} title={showKey ? 'Hide' : 'Show'}><Icon name={showKey ? 'moon' : 'sun'} /></button>
          </div>
          <span className="faint small">
            Stored only in this browser. Without a key, requests are spaced ~1/s and may be throttled. Get one at{' '}
            <a href="https://www.semanticscholar.org/product/api#api-key-form" target="_blank" rel="noopener noreferrer">semanticscholar.org</a>.
          </span>
        </label>

        <label className="field">
          <span>References / citations fetched per paper: <strong>{settings.listLimit}</strong></span>
          <input type="range" min={50} max={S2_LIMITS.list} step={50} value={settings.listLimit} onChange={(e) => update({ listLimit: Number(e.target.value) })} />
          <span className="faint small">Larger lists show more of highly-cited papers but take longer to download.</span>
        </label>

        <label className="field">
          <span>New map nodes per expansion (per direction): <strong>{settings.graphExpandLimit}</strong></span>
          <input type="range" min={10} max={500} step={10} value={settings.graphExpandLimit} onChange={(e) => update({ graphExpandLimit: Number(e.target.value) })} />
          <span className="faint small">The most-cited papers are added first; connections to papers already in the map are always drawn.</span>
        </label>

        <label className="field check">
          <input type="checkbox" checked={settings.autoExpandSeeds} onChange={(e) => update({ autoExpandSeeds: e.target.checked })} />
          <span>Automatically load connections of new seed papers</span>
        </label>

        <div className="field">
          <span>Node labels</span>
          <div className="segmented">
            {(['seeds', 'auto', 'all'] as LabelMode[]).map((m) => (
              <button key={m} className={settings.labelMode === m ? 'active' : ''} onClick={() => update({ labelMode: m })}>
                {m === 'seeds' ? 'Seeds only' : m === 'auto' ? 'Auto' : 'All'}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <span>Theme</span>
          <div className="segmented">
            {(['system', 'light', 'dark'] as Theme[]).map((t) => (
              <button key={t} className={settings.theme === t ? 'active' : ''} onClick={() => update({ theme: t })}>
                {t[0]!.toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <span>Local cache</span>
          <div className="row">
            <button className="btn" onClick={() => void clearCache()}><Icon name="trash" /> Clear cached papers</button>
            <span className="faint small">Papers and lists are cached in your browser for a few days to avoid repeat downloads.</span>
          </div>
        </div>
      </div>
    </dialog>
  );
}
