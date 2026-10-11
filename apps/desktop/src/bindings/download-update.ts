import { Channel } from '@tauri-apps/api/core'
import { invokeResult, type CommandResult } from './invoke-result'
import type { DownloadProgressDto, ReleaseDto, UpdateCommandError } from './update-types'

/** Baixa e verifica a assinatura do pacote da versão mais recente; ele fica
 * guardado no backend até `installUpdateAndRestart`. */
export function downloadUpdate(
  operationId: string,
  onProgress: (progress: DownloadProgressDto) => void,
): Promise<CommandResult<ReleaseDto, UpdateCommandError>> {
  const channel = new Channel<DownloadProgressDto>()
  channel.onmessage = onProgress
  return invokeResult('download_update', { input: { operationId }, onProgress: channel })
}
