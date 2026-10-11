import { useEffect, useState } from 'react'
import { getMockServer, listMockServers } from '../../bindings/mock-servers'
import type { MockServerDto, MockServerSummaryDto } from '../../bindings/mock-servers'
import { MOCK_SERVERS_CHANGED_EVENT } from '../mock-servers/mock-server-defaults'

export interface FlowMockServers {
  /** Mocks salvos do workspace, para o seletor do bloco "Ligar mock". */
  summaries: MockServerSummaryDto[]
  /** Configuração completa dos mocks salvos usados no flow, por id. */
  savedServers: Record<string, MockServerDto>
}

/** Mocks salvos que o canvas precisa para mostrar e configurar os blocos de
 * mock (spec 0121). Recarrega quando um mock é salvo, excluído, ligado ou
 * desligado em outra aba. Só busca a configuração completa dos mocks que
 * algum bloco usa. */
export function useFlowMockServers(rootPath: string, usedServerIds: string[]): FlowMockServers {
  const [state, setState] = useState<FlowMockServers>({ summaries: [], savedServers: {} })
  const idsKey = usedServerIds.join('\n')

  useEffect(() => {
    let cancelled = false
    const ids = idsKey ? idsKey.split('\n') : []
    const load = async () => {
      const [list, ...servers] = await Promise.all([listMockServers(rootPath), ...ids.map((id) => getMockServer(rootPath, id))])
      if (cancelled) return
      const savedServers: Record<string, MockServerDto> = {}
      for (const result of servers) {
        if (result.ok) savedServers[result.value.id] = result.value
      }
      setState({ summaries: list.ok ? list.value.servers : [], savedServers })
    }
    void load()
    const handleChanged = () => void load()
    window.addEventListener(MOCK_SERVERS_CHANGED_EVENT, handleChanged)
    return () => {
      cancelled = true
      window.removeEventListener(MOCK_SERVERS_CHANGED_EVENT, handleChanged)
    }
  }, [rootPath, idsKey])

  return state
}
