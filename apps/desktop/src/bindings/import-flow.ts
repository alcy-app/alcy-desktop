import { invoke } from '@tauri-apps/api/core'
import { pickPath } from './pick-paths'
import type { FlowDto } from './list-flows'
import type { LoadTestImportAnalysisDto } from './load-test-import'

export type FlowImportAnalysis = { type: 'alcy'; flow: FlowDto } | { type: 'loadTest'; analysis: LoadTestImportAnalysisDto }

export async function pickFlowImportFile(loadTestingEnabled: boolean): Promise<string | null> {
  const filter = loadTestingEnabled
    ? { name: 'Alcy / k6 / JMeter', extensions: ['json', 'js', 'ts', 'jmx', 'xml'] }
    : { name: 'Alcy Flow', extensions: ['json'] }
  return pickPath({ filters: [filter] })
}

/** Decode and validate without saving or executing the imported graph. */
export async function readFlowImport(sourcePath: string): Promise<FlowImportAnalysis> {
  return invoke('analyze_flow_import', { input: { sourcePath } })
}
