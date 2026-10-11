import { open } from '@tauri-apps/plugin-dialog'

/** Escolhe um bundle PEM de autoridades certificadoras para o cliente HTTP. */
export async function pickCustomCaCertificate(): Promise<string | null> {
  const selected = await open({
    directory: false,
    multiple: false,
    filters: [{ name: 'PEM', extensions: ['pem', 'crt', 'cer'] }],
  })
  return typeof selected === 'string' ? selected : null
}
