import type { ComponentType, ReactNode } from 'react'
import type { Language } from '../shared/i18n/translations'

/** Text shown by the app on behalf of an extension, in every interface language. */
export type LocalizedText = Record<Language, string>

/** Id of an extension's sidebar module or workbench tab; the prefix keeps it apart from the app's own ids. */
export type ExtensionId = `ext:${string}`

/** A module in the sidebar's activity bar, contributed by an extension. */
export interface ExtensionSidebarModule {
  id: ExtensionId
  label: LocalizedText
  icon: ReactNode
  /** Panel shown while the module is active. It reads its own state (usually from the extension's `AppWrapper`). */
  Panel: ComponentType
}

/**
 * A tab in the workbench bar that is not a request or flow tab. The workbench
 * shows `content` while the tab is active and deactivates extension tabs when
 * the open request/flow tab changes.
 */
export interface PseudoTab {
  id: string
  label: string
  dirty: boolean
  /** Shown in italics, like a preview tab. */
  preview?: boolean
  active: boolean
  activate: () => void
  deactivate: () => void
  /** Closes the tab. The tab bar has already confirmed discarding unsaved changes. */
  close: () => void
  content: ReactNode
  /** While active, dropped files and the save-request shortcut do not reach the open request. */
  capturesInput?: boolean
}

/**
 * Additions a downstream build plugs into the app without editing shared
 * files: put a folder with an `index.ts` that default-exports this object
 * under `src/extensions/`.
 */
export interface AppExtension {
  id: string
  /** Wraps the whole app inside the language and toast providers (e.g. an activation gate or a shared state provider). */
  AppWrapper?: ComponentType<{ children: ReactNode }>
  sidebarModules?: ExtensionSidebarModule[]
  /** Hook that returns the extension's current workbench tabs. Called on every workbench render. */
  useWorkbenchTabs?: () => PseudoTab[]
}
