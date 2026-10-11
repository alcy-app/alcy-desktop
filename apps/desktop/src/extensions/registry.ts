import type { AppExtension, ExtensionSidebarModule, PseudoTab } from './types'

/** Every `src/extensions/<name>/index.ts` found at build time. The app itself ships none. */
const modules = import.meta.glob<{ default: AppExtension }>('./*/index.ts', { eager: true })

export const APP_EXTENSIONS: readonly AppExtension[] = Object.keys(modules)
  .sort()
  .map((path) => modules[path].default)

export const EXTENSION_SIDEBAR_MODULES: readonly ExtensionSidebarModule[] = APP_EXTENSIONS.flatMap(
  (extension) => extension.sidebarModules ?? [],
)

// The list is fixed at build time, so calling each extension's hook in order
// keeps the hook call order stable across renders.
const readTabsOfEachExtension = APP_EXTENSIONS.flatMap((extension) =>
  extension.useWorkbenchTabs ? [extension.useWorkbenchTabs] : [],
)

/** Workbench tabs contributed by extensions, in extension order. */
export function useExtensionWorkbenchTabs(): PseudoTab[] {
  return readTabsOfEachExtension.flatMap((readTabs) => readTabs())
}
