import type { AzureActivePr, AzureRepoRef } from "./azure-pr.js";

export type PrAttention = "new" | "published";

export type PersistedPrMenuRepoState = {
  known: Record<string, { isDraft: boolean }>;
  attention: Record<string, PrAttention>;
};

type AttentionInput = { id: number; isDraft: boolean };

type WorktreeSummary = { name: string; path: string; branch: string };

export type AzurePrMenuItem = AzureActivePr & {
  updatedAt: number;
  worktree: { name: string; path: string; dirty: boolean } | null;
  attention: PrAttention | null;
};

export type AzurePrMenuResponse =
  | { supported: false; projectRoot: string }
  | { supported: true; projectRoot: string; fetchedAt: number; prs: AzurePrMenuItem[] };

type PreferenceStore = {
  getPreference: <T = unknown>(key: string) => T | undefined;
  setPreference: (key: string, value: unknown) => void;
};

export type AzurePrMenuService = {
  list: (projectRoot: string) => Promise<AzurePrMenuResponse>;
  acknowledge: (projectRoot: string, markers: Array<{ id: number; attention: PrAttention }>) => Promise<void>;
};

type AzurePrMenuServiceDeps = {
  store: PreferenceStore;
  cacheTtlMs: number;
  now: () => number;
  repoRootFromCwd: (cwd: string) => string | null;
  repoRefForRoot: (repoRoot: string) => Promise<AzureRepoRef | null>;
  listActivePrs: (ref: AzureRepoRef) => Promise<AzureActivePr[]>;
  latestUpdateAt: (ref: AzureRepoRef, pr: AzureActivePr) => Promise<number>;
  listWorktrees: (repoRoot: string) => WorktreeSummary[];
  worktreeStatus: (path: string) => Promise<{ dirty: boolean }>;
};

const PR_MENU_STATE_PREF = "azurePrMenuState";

export function reconcilePrMenuState(
  previous: PersistedPrMenuRepoState | undefined,
  prs: AttentionInput[],
): PersistedPrMenuRepoState {
  const firstLoad = previous === undefined;
  const known = { ...(previous?.known ?? {}) };
  const attention = { ...(previous?.attention ?? {}) };

  for (const pr of prs) {
    const key = String(pr.id);
    const prior = known[key];
    if (!firstLoad && !prior) attention[key] = "new";
    if (prior?.isDraft && !pr.isDraft) attention[key] = "published";
    known[key] = { isDraft: pr.isDraft };
  }

  return { known, attention };
}

export function acknowledgePrAttention(
  state: PersistedPrMenuRepoState,
  viewed: Array<{ id: number; attention: PrAttention }>,
): PersistedPrMenuRepoState {
  const attention = { ...state.attention };
  for (const marker of viewed) {
    const key = String(marker.id);
    if (attention[key] === marker.attention) delete attention[key];
  }
  return { known: state.known, attention };
}

export function matchPrWorktree(sourceBranch: string, worktrees: WorktreeSummary[]): WorktreeSummary | null {
  return worktrees.find((worktree) => worktree.branch === sourceBranch) ?? null;
}

function readAllState(store: PreferenceStore): Record<string, PersistedPrMenuRepoState> {
  const value = store.getPreference<unknown>(PR_MENU_STATE_PREF);
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, PersistedPrMenuRepoState>;
}

export function createAzurePrMenuService(deps: AzurePrMenuServiceDeps): AzurePrMenuService {
  const cache = new Map<string, { at: number; result: AzurePrMenuResponse }>();
  const inflight = new Map<string, Promise<AzurePrMenuResponse>>();

  async function refresh(repoRoot: string): Promise<AzurePrMenuResponse> {
    const ref = await deps.repoRefForRoot(repoRoot);
    if (!ref) return { supported: false, projectRoot: repoRoot };

    const activePrs = await deps.listActivePrs(ref);
    const worktrees = deps.listWorktrees(repoRoot);
    const stateByRepo = readAllState(deps.store);
    const repoState = reconcilePrMenuState(stateByRepo[repoRoot], activePrs);
    stateByRepo[repoRoot] = repoState;
    deps.store.setPreference(PR_MENU_STATE_PREF, stateByRepo);

    const prs = await Promise.all(activePrs.map(async (pr): Promise<AzurePrMenuItem> => {
      const matched = matchPrWorktree(pr.sourceBranch, worktrees);
      const [updatedAt, dirty] = await Promise.all([
        deps.latestUpdateAt(ref, pr).catch(() => pr.createdAt),
        matched ? deps.worktreeStatus(matched.path).then((status) => status.dirty).catch(() => false) : false,
      ]);
      return {
        ...pr,
        updatedAt,
        worktree: matched ? { name: matched.name, path: matched.path, dirty } : null,
        attention: repoState.attention[String(pr.id)] ?? null,
      };
    }));
    prs.sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id);
    return { supported: true, projectRoot: repoRoot, fetchedAt: deps.now(), prs };
  }

  async function list(projectRoot: string): Promise<AzurePrMenuResponse> {
    const repoRoot = deps.repoRootFromCwd(projectRoot) ?? projectRoot;
    const cached = cache.get(repoRoot);
    if (cached && deps.now() - cached.at < deps.cacheTtlMs) return cached.result;
    const pending = inflight.get(repoRoot);
    if (pending) return pending;

    const request = refresh(repoRoot)
      .then((result) => {
        cache.set(repoRoot, { at: deps.now(), result });
        return result;
      })
      .finally(() => inflight.delete(repoRoot));
    inflight.set(repoRoot, request);
    return request;
  }

  async function acknowledge(
    projectRoot: string,
    markers: Array<{ id: number; attention: PrAttention }>,
  ): Promise<void> {
    const repoRoot = deps.repoRootFromCwd(projectRoot) ?? projectRoot;
    const stateByRepo = readAllState(deps.store);
    const repoState = stateByRepo[repoRoot];
    if (!repoState) return;
    stateByRepo[repoRoot] = acknowledgePrAttention(repoState, markers);
    deps.store.setPreference(PR_MENU_STATE_PREF, stateByRepo);

    const cached = cache.get(repoRoot);
    if (!cached?.result.supported) return;
    const viewed = new Map(markers.map((marker) => [marker.id, marker.attention]));
    cached.result = {
      ...cached.result,
      prs: cached.result.prs.map((pr) => (
        pr.attention && viewed.get(pr.id) === pr.attention ? { ...pr, attention: null } : pr
      )),
    };
  }

  return { list, acknowledge };
}
