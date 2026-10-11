import { invoke } from '@tauri-apps/api/core'

/** Cancela uma verificação ou download de atualização (idempotente). */
export async function cancelUpdateOperation(operationId: string): Promise<void> {
  try {
    await invoke('cancel_update_operation', { input: { operationId } })
  } catch {
    // Cancelar uma operação que já terminou não é um erro para o usuário.
  }
}
