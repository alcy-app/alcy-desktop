import { open } from '@tauri-apps/plugin-dialog'

/** Fonte local de k6 ou JMeter. A extensão só filtra o diálogo: o backend
 * identifica e valida o conteúdo antes de mostrar o preview. */
export async function pickLoadTestFile(): Promise<string | null> {
  const selected = await open({
    directory: false,
    multiple: false,
    filters: [{ name: 'k6 ou JMeter', extensions: ['js', 'ts', 'jmx'] }],
  })
  if (selected === null) return null
  return typeof selected === 'string' ? selected : (selected[0] ?? null)
}
