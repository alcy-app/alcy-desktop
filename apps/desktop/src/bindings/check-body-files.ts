import { invoke } from '@tauri-apps/api/core'

/** Para cada caminho de arquivo de corpo (relativo ao workspace ou absoluto),
 * se ele existe nesta máquina. Em caso de falha do IPC, considera todos
 * presentes — melhor não avisar do que avisar errado; o envio ainda
 * reporta um arquivo ausente com erro claro. */
export async function checkBodyFiles(rootPath: string, paths: string[]): Promise<boolean[]> {
  if (paths.length === 0) return []
  try {
    return await invoke<boolean[]>('check_body_files', { input: { rootPath, paths } })
  } catch {
    return paths.map(() => true)
  }
}
