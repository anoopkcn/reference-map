import { useSeeds } from '../store/selectors';
import { Icon } from './icons';
import { IndexCard } from './IndexCard';
import { SearchResults } from './SearchResults';
import { SeedInput } from './SeedInput';

export function SeedPanel() {
  const seeds = useSeeds();
  return (
    <div className="sidebar-scroll">
      <SeedInput />
      <SearchResults />
      {seeds.length === 0 ? (
        <div className="empty-state">
          <Icon name="graph" size={28} />
          <p><strong>Start with a paper.</strong></p>
          <p className="muted">
            Paste a DOI, arXiv id or URL above. Its references and citations become the first ring of the map;
            double-click any node (or use <em>Expand</em>) to grow the map from there.
          </p>
          <p className="muted small">
            Examples: <code>10.18653/v1/N18-3011</code> · <code>arXiv:1706.03762</code> · <code>attention is all you need</code>
          </p>
        </div>
      ) : (
        seeds.map((seed) => <IndexCard key={seed.lookup} seed={seed} />)
      )}
    </div>
  );
}
