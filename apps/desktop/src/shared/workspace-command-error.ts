import type { WorkspaceCommandError } from '../bindings/create-workspace'
import type { TranslationKey } from './i18n/translations'

export function workspaceErrorMessageKey(error: WorkspaceCommandError): TranslationKey {
  switch (error.kind) {
    case 'notAWorkspace':
      return 'startScreen.errorNotAWorkspace'
    case 'notOwner':
      return 'workspaceMenu.errorNotOwner'
    case 'invalidFolderName':
      return 'workspaceMenu.errorInvalidFolderName'
    case 'folderExists':
      return 'workspaceMenu.errorFolderExists'
    case 'folderInUse':
      return 'workspaceMenu.errorFolderInUse'
    case 'workspaceBusy':
      return 'workspaceMenu.errorWorkspaceBusy'
    case 'invalid':
      return 'startScreen.errorInvalid'
    case 'storage':
      return 'startScreen.errorStorage'
  }
}
