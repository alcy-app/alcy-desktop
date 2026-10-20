export interface DisplayBodySource {
  rootPath: string
  flowExecutionId: string
  nodeId: string
  version?: number
}

/** Whole-body references reuse archived, redacted pages instead of the event summary. */
export function displayBodyNodeId(template: string): string | null {
  return /^\{\{\s*nodes\.([^.{}\s]+)\.(?:response|request)\.body\s*\}\}$/.exec(template.trim())?.[1] ?? null
}
