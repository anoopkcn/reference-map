import { NodeRole, type NodeRole as NodeRoleType } from '../types';
import { roleIsVisible } from './frame';

const ITEMS: { role: NodeRoleType; className: string; label: string; description?: string }[] = [
  { role: NodeRole.Seed, className: 'seed', label: 'Seed paper' },
  { role: NodeRole.Cited, className: 'cited', label: 'Reference', description: '— cited by a paper in the map' },
  { role: NodeRole.Citing, className: 'citing', label: 'Citation', description: '— cites a paper in the map' },
  { role: NodeRole.Both, className: 'both', label: 'Both', description: '— reference and citation' },
];

export function GraphLegend({ visibleRoleMask, onToggleRole }: { visibleRoleMask: number; onToggleRole: (role: NodeRoleType) => void }) {
  return (
    <div className="graph-legend" aria-label="Filter papers by category">
      {ITEMS.map((item) => {
        const visible = roleIsVisible(visibleRoleMask, item.role);
        return (
          <button
            type="button"
            className="legend-toggle"
            aria-pressed={visible}
            title={`${visible ? 'Hide' : 'Show'} ${item.label.toLowerCase()}`}
            onClick={() => onToggleRole(item.role)}
            key={item.role}
          >
            <span className={`dot ${item.className}`} />
            <span>{item.label}</span>
            {item.description && <span className="faint">{item.description}</span>}
          </button>
        );
      })}
      <div className="legend-note faint small">Size ∝ citation count · ring = connections loaded · dot = pinned</div>
    </div>
  );
}
