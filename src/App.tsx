import { useEffect, useState } from 'react';
import { SeedPanel } from './components/SeedPanel';
import { SettingsDialog } from './components/SettingsDialog';
import { Toasts } from './components/Toast';
import { ZoteroCollectionDialog } from './components/ZoteroCollectionDialog';
import { ZoteroFooter } from './components/ZoteroFooter';
import { Icon, Logo } from './components/icons';
import { GraphPanel } from './graph/GraphPanel';
import { useTheme } from './hooks/useTheme';
import { useUrlSync } from './hooks/useUrlSync';
import { useAppStore } from './store';
import { PROVIDER_LABEL, PROVIDER_SHORT } from './types';

export function App() {
  const resolved = useTheme();
  useUrlSync();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('cards');
  const update = useAppStore((s) => s.updateSettings);
  const select = useAppStore((s) => s.select);
  const zoteroDialogOpen = useAppStore((s) => s.zotero.collectionDialogOpen);
  const probeLocal = useAppStore((s) => s.zoteroProbeLocal);
  const zoteroLocalUp = useAppStore((s) => s.zotero.localAvailable);

  // After the user approves access in Zotero (or starts Zotero), returning to this tab reconnects.
  useEffect(() => {
    if (zoteroLocalUp) return;
    const onFocus = () => void probeLocal();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [zoteroLocalUp, probeLocal]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !settingsOpen && !zoteroDialogOpen) select(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [select, settingsOpen, zoteroDialogOpen]);

  return (
    <div className="app" data-tab={tab}>
      <main className="main">
        <aside className="sidebar">
          <header className="header">
            <div className="brand"><Logo /> Reference Map</div>
            <Tabs tab={tab} onTab={setTab} />
            <div className="header-spacer" />
            <ProviderPill />
            <button className="btn ghost icon" onClick={() => update({ theme: resolved === 'dark' ? 'light' : 'dark' })} title={`Switch to ${resolved === 'dark' ? 'light' : 'dark'} theme`} aria-label="Toggle theme">
              <Icon name={resolved === 'dark' ? 'sun' : 'moon'} />
            </button>
            <button className="btn ghost icon" onClick={() => setSettingsOpen(true)} title="Settings" aria-label="Settings"><Icon name="settings" /></button>
          </header>
          <SeedPanel />
          <ZoteroFooter onOpenSettings={() => setSettingsOpen(true)} />
          <SidebarResizer />
        </aside>
        <GraphPanel themeKey={resolved} tab={tab} onTab={setTab} />
      </main>
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <ZoteroCollectionDialog />
      <Toasts />
    </div>
  );
}

export type Tab = 'cards' | 'graph';

const SIDEBAR_W_KEY = 'refmap.sidebarW';
const SIDEBAR_MIN = 300;
const sidebarMax = () => Math.max(SIDEBAR_MIN, Math.round(window.innerWidth * 0.6));
const clampSidebar = (px: number) => Math.min(Math.max(Math.round(px), SIDEBAR_MIN), sidebarMax());

function applySidebarWidth(px: number | null): void {
  const root = document.documentElement;
  if (px === null) root.style.removeProperty('--sidebar-w');
  else root.style.setProperty('--sidebar-w', `${px}px`);
}

function saveSidebarWidth(px: number | null): void {
  try {
    if (px === null) localStorage.removeItem(SIDEBAR_W_KEY);
    else localStorage.setItem(SIDEBAR_W_KEY, String(px));
  } catch {
    /* private mode */
  }
}

/** Drag handle on the sidebar's right edge. Width is a per-browser preference; double-click resets. */
function SidebarResizer() {
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(SIDEBAR_W_KEY));
      if (Number.isFinite(saved) && saved >= SIDEBAR_MIN) applySidebarWidth(clampSidebar(saved));
    } catch {
      /* private mode */
    }
  }, []);

  // The sidebar starts at x = 0, so the pointer's clientX is the desired width.
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragging) applySidebarWidth(clampSidebar(e.clientX));
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    setDragging(false);
    saveSidebarWidth(clampSidebar(e.clientX));
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const current = document.querySelector('aside.sidebar')?.getBoundingClientRect().width ?? SIDEBAR_MIN;
    const next = clampSidebar(current + (e.key === 'ArrowRight' ? 24 : -24));
    applySidebarWidth(next);
    saveSidebarWidth(next);
  };

  return (
    <div
      className={`sidebar-resizer ${dragging ? 'dragging' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => {
        applySidebarWidth(null);
        saveSidebarWidth(null);
      }}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      tabIndex={0}
      onKeyDown={onKeyDown}
      title="Drag to resize the sidebar · double-click to reset"
    />
  );
}

/** Papers / Map switcher, shown only on narrow screens. */
export function Tabs({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  return (
    <div className="tabs" role="tablist">
      <button role="tab" aria-selected={tab === 'cards'} className={tab === 'cards' ? 'active' : ''} onClick={() => onTab('cards')}>Papers</button>
      <button role="tab" aria-selected={tab === 'graph'} className={tab === 'graph' ? 'active' : ''} onClick={() => onTab('graph')}>Map</button>
    </div>
  );
}

/** Shows queue depth, rate-limit pauses and degraded sources. */
function ProviderPill() {
  const providers = useAppStore((s) => s.providers);
  const [, tick] = useState(0);
  const list = Object.values(providers);
  const now = Date.now();
  const paused = list.filter((p) => p.pausedUntil !== null && p.pausedUntil > now);
  useEffect(() => {
    if (paused.length === 0) return;
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [paused.length]);
  const busy = list.reduce((n, p) => n + p.pending + p.active, 0);
  const degraded = list.filter((p) => p.recentErrors > 0);
  if (paused.length) {
    const p = paused[0]!;
    const secs = Math.max(0, Math.ceil((p.pausedUntil! - now) / 1000));
    return (
      <div className="pill warn" title={`${PROVIDER_LABEL[p.id]} asked us to slow down — retrying in ${secs}s${list.length > 1 ? '; other sources keep working' : ''}`}>
        <Icon name="alert" size={13} /> {PROVIDER_SHORT[p.id]} limited · {secs}s
      </div>
    );
  }
  if (busy) {
    return (
      <div className="pill" title={`${busy} request${busy > 1 ? 's' : ''} in flight or waiting for the rate limiter`}>
        <span className="spinner" /> {busy} queued
      </div>
    );
  }
  if (degraded.length) {
    return (
      <div className="pill warn" title={degraded.map((p) => `${PROVIDER_LABEL[p.id]}: ${p.lastError ?? 'recent errors'}`).join('\n')}>
        <Icon name="alert" size={13} /> {degraded.map((p) => PROVIDER_SHORT[p.id]).join(' · ')} degraded
      </div>
    );
  }
  return null;
}
