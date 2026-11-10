import type { ExampleResponse } from './collection-tree'
import { detectBodyMode } from './response-body-mode'
import { httpResultOf, type ExecutionState } from './request-workbench.types'

/** The displayed HTTP response as an example, or null when it cannot be one:
 * binary bodies and bodies too large to be held in memory stay out of the
 * collections file. */
export function exampleResponseFromExecution(execution: ExecutionState): ExampleResponse | null {
  if (execution.status !== 'success') return null
  const result = httpResultOf(execution.result)
  if (!result || result.body.kind !== 'inline' || result.bodyEncoding !== 'text') return null
  return {
    statusCode: result.statusCode,
    headers: result.headers.map(({ name, value }) => ({ name, value, enabled: true })),
    body: result.body.body,
    language: detectBodyMode(result.headers, result.body.body),
  }
}
