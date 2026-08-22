import { useEffect, useState } from 'react';
import { SeedPanel } from './components/SeedPanel';
import { SettingsDialog } from './components/SettingsDialog';
import { Toasts } from './components/Toast';
import { Icon, Logo } from './components/icons';
import { GraphPanel } from './graph/GraphPanel';
import { useTheme } from './hooks/useTheme';
import { useUrlSync } from './hooks/useUrlSync';
import { useAppStore } from './store';

export function App() {
  const resolved = useTheme();
  useUrlSync();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tab, setTab] = useState<'cards' | 'graph'>('cards');
  const update = useAppStore((s) => s.updateSettings);
  const select = useAppStore((s) => s.select);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !settingsOpen) select(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [select, settingsOpen]);

  return (
    <div className="app" data-tab={tab}>
      <header className="header">
        <div className="brand"><Logo /> Reference Map</div>
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'cards'} className={tab === 'cards' ? 'active' : ''} onClick={() => setTab('cards')}>Papers</button>
          <button role="tab" aria-selected={tab === 'graph'} className={tab === 'graph' ? 'active' : ''} onClick={() => setTab('graph')}>Map</button>
        </div>
        <div className="header-spacer" />
        <QueuePill />
        <button className="btn ghost icon" onClick={() => update({ theme: resolved === 'dark' ? 'light' : 'dark' })} title={`Switch to ${resolved === 'dark' ? 'light' : 'dark'} theme`} aria-label="Toggle theme">
          <Icon name={resolved === 'dark' ? 'sun' : 'moon'} />
        </button>
        <button className="btn ghost icon" onClick={() => setSettingsOpen(true)} title="Settings" aria-label="Settings"><Icon name="settings" /></button>
      </header>
      <main className="main">
        <aside className="sidebar"><SeedPanel /></aside>
        <GraphPanel themeKey={resolved} />
      </main>
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <Toasts />
    </div>
  );
}

/** Shows queue depth and rate-limit pauses. */
function QueuePill() {
  const q = useAppStore((s) => s.queue);
  const [, tick] = useState(0);
  const paused = q.pausedUntil !== null && q.pausedUntil > Date.now();
  useEffect(() => {
    if (!paused) return;
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [paused, q.pausedUntil]);
  const busy = q.pending + q.active;
  if (!busy && !paused) return null;
  const secs = paused ? Math.max(0, Math.ceil((q.pausedUntil! - Date.now()) / 1000)) : 0;
  return (
    <div className={`pill ${paused ? 'warn' : ''}`} title={paused ? 'Semantic Scholar asked us to slow down; requests resume automatically' : 'Requests waiting for the rate limiter'}>
      {paused ? <Icon name="alert" size={13} /> : <span className="spinner" />}
      {paused ? `Rate limited · retry in ${secs}s` : `${busy} request${busy > 1 ? 's' : ''} queued`}
    </div>
  );
}
