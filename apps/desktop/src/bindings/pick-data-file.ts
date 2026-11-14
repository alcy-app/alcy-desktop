import { pickPath } from './pick-paths'

/** Opens the native dialog to choose the runner's data file (CSV or JSON). */
export function pickDataFile(): Promise<string | null> {
  return pickPath({ filters: [{ name: 'CSV / JSON', extensions: ['csv', 'json'] }] })
}
