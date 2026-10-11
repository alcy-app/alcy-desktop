import type { VersionControl } from './use-version-control'

/** `VersionControl` mínimo para testar componentes que só usam uma fatia dele (ex.: `pull`, `resolve`, `busy`). */
export function fakeVersionControl(overrides: Partial<VersionControl> = {}): VersionControl {
  return {
    linkLoaded: true,
    link: null,
    files: [],
    counts: { local: 0, remote: 0, conflicts: 0 },
    summary: 'clean',
    checking: false,
    busy: null,
    error: null,
    notice: null,
    message: '',
    setMessage: () => {},
    statusVersion: 0,
    staged: {},
    stagedSelections: [],
    stageFile: () => {},
    stageItem: () => {},
    unstageFile: () => {},
    unstageItem: () => {},
    reconcileStaged: () => {},
    refresh: async () => {},
    notifyLocalChange: () => {},
    cancel: () => {},
    linkTo: async () => ({ ok: true }),
    unlink: async () => ({ ok: true }),
    pull: async () => ({ ok: true }),
    push: async () => ({ ok: true }),
    resolve: async () => ({ ok: true }),
    clearMessages: () => {},
    ...overrides,
  }
}
