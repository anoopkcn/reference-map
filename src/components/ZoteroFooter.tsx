import { useState } from 'react';
import { useAppStore } from '../store';
import { Icon } from './icons';

const DISMISS_KEY = 'refmap.zoteroHintDismissed';

function isDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Bottom-of-sidebar Zotero panel: setup guidance while nothing is connected,
 * a one-line status once something is. Waits for the startup probe so it never
 * flashes the wrong state on load.
 */
export function ZoteroFooter({ onOpenSettings }: { onOpenSettings: () => void }) {
  const localSupported = useAppStore((s) => s.zotero.localSupported);
  const probed = useAppStore((s) => s.zotero.localProbed);
  const local = useAppStore((s) => s.zotero.localAvailable);
  const hasKey = useAppStore((s) => !!s.settings.zoteroApiKey);
  const username = useAppStore((s) => s.settings.zoteroUsername);
  const [hidden, setHidden] = useState(isDismissed);

  if (localSupported && !probed && !hasKey) return null;

  if (local || hasKey) {
    const status = local
      ? `Zotero connected — searching the app on this computer${hasKey ? ' · zotero.org key set' : ''}`
      : `Zotero via zotero.org${username ? ` as ${username}` : ''}${localSupported ? ' — start the Zotero app for instant local search' : ''}`;
    return (
      <div className="sidebar-footer">
        <Icon name="bookmark" size={12} /> <span>{status}</span>
      </div>
    );
  }

  if (hidden) return null;
  return (
    <div className="sidebar-footer setup">
      <div className="sidebar-footer-head">
        <span><Icon name="bookmark" size={12} /> Connect Zotero <span className="faint">(optional)</span></span>
        <button
          className="btn ghost icon sm"
          onClick={() => {
            setHidden(true);
            try {
              localStorage.setItem(DISMISS_KEY, '1');
            } catch {
              /* private mode */
            }
          }}
          aria-label="Hide Zotero setup hint"
          title="Hide"
        >
          <Icon name="close" size={12} />
        </button>
      </div>
      <p>Search your library while you type, and save papers (with PDFs) back into it.</p>
      {import.meta.env.DEV ? (
        <>
          <p>
            <strong>Local</strong> — keep the Zotero app running and enable “Allow other applications on this computer to
            communicate with Zotero” in its Settings → Advanced. No account needed.
          </p>
          <p>
            <strong>zotero.org</strong> — create an API key (library read + write) and paste it in{' '}
            <button className="linklike" onClick={onOpenSettings}>Settings</button>, for when the app isn’t running.
          </p>
        </>
      ) : (
        <>
          <p>
            <strong>Local</strong> — install the{' '}
            <a href="https://github.com/anoopkcn/reference-map/releases" target="_blank" rel="noopener noreferrer">Reference Map Connect</a>{' '}
            plugin in Zotero, keep Zotero running, and approve this site when Zotero asks. Keyless and instant.
          </p>
          <p>
            <strong>zotero.org</strong> — or create an API key (library read + write) and paste it in{' '}
            <button className="linklike" onClick={onOpenSettings}>Settings</button>. Works without the plugin, via your synced library.
          </p>
        </>
      )}
    </div>
  );
}
