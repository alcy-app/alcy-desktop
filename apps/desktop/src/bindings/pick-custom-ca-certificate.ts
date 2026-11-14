import { pickPath } from './pick-paths'

/** Chooses a PEM bundle of certificate authorities for the HTTP client. */
export function pickCustomCaCertificate(): Promise<string | null> {
  return pickPath({ filters: [{ name: 'PEM', extensions: ['pem', 'crt', 'cer'] }] })
}
