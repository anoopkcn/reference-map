import { useShallow } from 'zustand/react/shallow';
import type { ListKind, ListState, Paper, PaperId } from '../types';
import { useAppStore } from './index';

export const usePaper = (id: PaperId | null | undefined): Paper | undefined => useAppStore((s) => (id ? s.papers.get(id) : undefined));
export const useListState = (id: PaperId, kind: ListKind): ListState | undefined => useAppStore((s) => s.lists.get(id)?.[kind]);
export const useSeeds = () => useAppStore((s) => s.seeds);
export const useSettings = () => useAppStore((s) => s.settings);
export const useProviderStatus = () => useAppStore((s) => s.providers);
export const useSelectedId = () => useAppStore((s) => s.selectedId);
export const useIsExpanding = (id: PaperId) => useAppStore((s) => s.expanding.has(id));
export const useIsSeed = (id: PaperId) => useAppStore((s) => s.seeds.some((x) => x.paperId === id));
export const useActions = () =>
  useAppStore(
    useShallow((s) => ({
      addSeeds: s.addSeeds,
      removeSeed: s.removeSeed,
      loadList: s.loadList,
      expandNode: s.expandNode,
      refreshSeed: s.refreshSeed,
      selectByKey: s.selectByKey,
      ensureDetail: s.ensureDetail,
      searchPapers: s.searchPapers,
      clearSearch: s.clearSearch,
      select: s.select,
      hover: s.hover,
      setPinned: s.setPinned,
      unpinAll: s.unpinAll,
      updateSettings: s.updateSettings,
      clearCache: s.clearCache,
      pushToast: s.pushToast,
      dismissToast: s.dismissToast,
    })),
  );
