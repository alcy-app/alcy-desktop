import { invoke } from '@tauri-apps/api/core'

/** Cancela um login, envio ou atualização em andamento (idempotente). */
export async function cancelGitlabOperation(operationId: string): Promise<void> {
  try {
    await invoke('cancel_gitlab_operation', { input: { operationId } })
  } catch {
    // Cancelar uma operação que já terminou não é um erro para o usuário.
  }
}
