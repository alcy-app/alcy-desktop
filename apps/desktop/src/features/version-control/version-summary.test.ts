import { describe, expect, it } from 'vitest'
import type { FileStatusDto } from '../../bindings/gitlab-types'
import { countChanges, mergeLocalStatus, summarize } from './version-summary'

const file = (state: FileStatusDto['state']): FileStatusDto => ({ name: `${state}.json`, state })

const base = { linked: true, loaded: true, statusKnown: true, remoteStatusKnown: true, busy: false, failed: false }

describe('countChanges', () => {
  it('separa alterações locais, remoto à frente e conflitos', () => {
    const counts = countChanges([
      file('clean'),
      file('localAdded'),
      file('localModified'),
      file('localDeleted'),
      file('remoteChanged'),
      file('conflict'),
    ])
    expect(counts).toEqual({ local: 3, remote: 1, conflicts: 1 })
  })
})

describe('summarize', () => {
  const none = { local: 0, remote: 0, conflicts: 0 }

  it('cobre os estados sem vínculo, carregando, ocupado e erro', () => {
    expect(summarize({ ...base, loaded: false, counts: none })).toBe('loading')
    expect(summarize({ ...base, linked: false, counts: none })).toBe('unlinked')
    expect(summarize({ ...base, busy: true, counts: none })).toBe('busy')
    expect(summarize({ ...base, failed: true, statusKnown: false, counts: none })).toBe('error')
    expect(summarize({ ...base, statusKnown: false, counts: none })).toBe('loading')
    expect(summarize({ ...base, remoteStatusKnown: false, counts: none })).toBe('loading')
    expect(summarize({ ...base, remoteStatusKnown: false, failed: true, counts: none })).toBe('error')
  })

  it('mantém o status local utilizável quando uma atualização remota falha', () => {
    expect(summarize({ ...base, failed: true, counts: { local: 1, remote: 0, conflicts: 0 } })).toBe('changes')
  })

  it('prioriza conflito, depois alterações locais, depois remoto à frente', () => {
    expect(summarize({ ...base, counts: { local: 2, remote: 1, conflicts: 1 } })).toBe('conflict')
    expect(summarize({ ...base, counts: { local: 2, remote: 1, conflicts: 0 } })).toBe('changes')
    expect(summarize({ ...base, counts: { local: 0, remote: 1, conflicts: 0 } })).toBe('remoteAhead')
    expect(summarize({ ...base, counts: none })).toBe('clean')
  })
})

describe('mergeLocalStatus', () => {
  it('usa o resultado local quando não havia nada remoto conhecido antes', () => {
    const previous: FileStatusDto[] = [{ name: 'alcy-collections.json', state: 'clean' }]
    const local: FileStatusDto[] = [{ name: 'alcy-collections.json', state: 'localModified' }]

    expect(mergeLocalStatus(previous, local)).toEqual(local)
  })

  it('preserva um conflito já detectado mesmo que o diff local pareça limpo', () => {
    const previous: FileStatusDto[] = [{ name: 'alcy-collections.json', state: 'conflict' }]
    const local: FileStatusDto[] = [{ name: 'alcy-collections.json', state: 'clean' }]

    expect(mergeLocalStatus(previous, local)).toEqual([{ name: 'alcy-collections.json', state: 'conflict' }])
  })

  it('preserva remoteChanged enquanto o local não editou o arquivo', () => {
    const previous: FileStatusDto[] = [{ name: 'alcy-flows.json', state: 'remoteChanged' }]
    const local: FileStatusDto[] = [{ name: 'alcy-flows.json', state: 'clean' }]

    expect(mergeLocalStatus(previous, local)).toEqual([{ name: 'alcy-flows.json', state: 'remoteChanged' }])
  })

  it('promove remoteChanged para conflito quando o usuário edita em cima', () => {
    const previous: FileStatusDto[] = [{ name: 'alcy-flows.json', state: 'remoteChanged', remoteRevision: 'remote-2' }]
    const local: FileStatusDto[] = [{ name: 'alcy-flows.json', state: 'localModified', localRevision: 'local-2', remoteRevision: 'base' }]

    expect(mergeLocalStatus(previous, local)).toEqual([{
      name: 'alcy-flows.json',
      state: 'conflict',
      localRevision: 'local-2',
      remoteRevision: 'remote-2',
    }])
  })
})
