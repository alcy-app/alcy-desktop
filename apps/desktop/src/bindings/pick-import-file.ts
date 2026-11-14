import { pickPath, pickPaths } from './pick-paths'

/** Opens the native dialog to choose one or more importable documents. The
 * backend decides each file's format from its content, not its extension; a
 * Bruno tree collection file (`bruno.json`, `.bru`) imports the whole
 * collection. */
export function pickImportFiles(): Promise<string[]> {
  return pickPaths({
    multiple: true,
    filters: [{ name: 'Alcy / OpenAPI / Postman / Bruno / Insomnia / HAR / cURL / wget', extensions: ['json', 'yaml', 'yml', 'bru', 'har', 'sh', 'txt'] }],
  })
}

/** Opens the native dialog to choose a folder; the backend expands it into
 * the importable files inside it (`expandImportPaths`). */
export function pickImportFolder(): Promise<string | null> {
  return pickPath({ directory: true })
}
