import { SORT_KEYS, type SortDir, type SortKey } from '../types';
import { Icon } from './icons';

export function SortControl({ sortKey, sortDir, onChange }: { sortKey: SortKey; sortDir: SortDir; onChange: (k: SortKey, d: SortDir) => void }) {
  return (
    <div className="sort-control">
      <select className="select" value={sortKey} onChange={(e) => onChange(e.target.value as SortKey, sortDir)} aria-label="Sort by">
        {SORT_KEYS.map((k) => (
          <option key={k.key} value={k.key}>{k.label}</option>
        ))}
      </select>
      <button
        className="btn ghost icon sm"
        onClick={() => onChange(sortKey, sortDir === 'asc' ? 'desc' : 'asc')}
        title={sortDir === 'asc' ? 'Ascending (click for descending)' : 'Descending (click for ascending)'}
        aria-label="Toggle sort direction"
      >
        <Icon name={sortDir === 'asc' ? 'chevronDown' : 'chevronDown'} style={{ transform: sortDir === 'asc' ? 'rotate(180deg)' : undefined }} />
      </button>
    </div>
  );
}
