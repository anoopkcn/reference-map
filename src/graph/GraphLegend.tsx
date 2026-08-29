import { NodeRole, type NodeRole as NodeRoleType } from '../types';
import { useAppStore } from '../store';
import { roleIsVisible } from './frame';

const ITEMS: { role: NodeRoleType; className: string; shapeClass: string; label: string; description?: string }[] = [
  { role: NodeRole.Cited, className: 'cited', shapeClass: 'shape-solid', label: 'Reference', description: '— cited by a paper in the map' },
  { role: NodeRole.Citing, className: 'citing', shapeClass: 'shape-hollow', label: 'Citation', description: '— cites a paper in the map' },
  { role: NodeRole.Both, className: 'both', shapeClass: 'shape-both', label: 'Both', description: '— reference and citation' },
];

export function GraphLegend({
  visibleRoleMask,
  onToggleRole,
  rootRef,
}: {
  visibleRoleMask: number;
  onToggleRole: (role: NodeRoleType) => void;
  /** Lets the panel measure the legend so canvas axis labels can move above it. */
  rootRef?: (el: HTMLDivElement | null) => void;
}) {
  const layoutMode = useAppStore((s) => s.settings.layoutMode);
  // In confluence and timeline, colour = seed identity (the labelled seeds on the canvas name
  // the hues), so the role dots switch to the shape glyphs the canvas uses there.
  const seedColoured = layoutMode !== 'force';
  return (
    <div className="graph-legend" aria-label="Filter papers by category" ref={rootRef}>
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
            <span className={`dot ${seedColoured ? item.shapeClass : item.className}`} />
            <span>{item.label}</span>
            {item.description && <span className="faint">{item.description}</span>}
          </button>
        );
      })}
      <div className="legend-note faint small">
        {layoutMode === 'confluence' && 'Ring segments = linked seeds · size ∝ citation count · behind a seed = its papers · between seeds = bridges · centre = shared'}
        {layoutMode === 'timeline' && 'Ring segments = linked seeds · size ∝ citation count · x = year (older → newer) · y = citations (log)'}
        {layoutMode === 'force' && 'Size ∝ citation count · ring = connections loaded · dot = pinned'}
      </div>
    </div>
  );
}
