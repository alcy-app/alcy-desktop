import type { WorkspaceCommandError } from '../bindings/create-workspace'
import type { TranslationKey } from './i18n/translations'

export function workspaceErrorMessageKey(error: WorkspaceCommandError): TranslationKey {
  switch (error.kind) {
    case 'notAWorkspace':
      return 'startScreen.errorNotAWorkspace'
    case 'invalid':
      return 'startScreen.errorInvalid'
    case 'storage':
      return 'startScreen.errorStorage'
  }
}
