import { pickPath } from './pick-paths'

/** A local k6 or JMeter source. The extension only filters the dialog: the
 * backend identifies and validates the content before showing the preview. */
export function pickLoadTestFile(): Promise<string | null> {
  return pickPath({ filters: [{ name: 'k6 ou JMeter', extensions: ['js', 'ts', 'jmx'] }] })
}
