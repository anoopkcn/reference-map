import { useAppStore } from '../store';
import { Icon } from './icons';

export function Toasts() {
  const toasts = useAppStore((s) => s.toasts);
  const dismiss = useAppStore((s) => s.dismissToast);
  if (toasts.length === 0) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <Icon name={t.kind === 'error' ? 'alert' : 'check'} />
          <span>{t.text}</span>
          <button className="btn ghost icon sm" onClick={() => dismiss(t.id)} aria-label="Dismiss">
            <Icon name="close" />
          </button>
        </div>
      ))}
    </div>
  );
}
