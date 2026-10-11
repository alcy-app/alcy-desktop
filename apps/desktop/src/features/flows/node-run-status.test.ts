import { describe, expect, it } from 'vitest'
import { translate } from '../../shared/i18n/translations'
import type { TranslationKey, TranslationParams } from '../../shared/i18n/translations'
import { describeRunStatus, runStateClass } from './node-run-status'

const t = (key: TranslationKey, params?: TranslationParams) => translate('pt-BR', key, params)

describe('describeRunStatus', () => {
  it('não mostra chip em repouso', () => {
    expect(describeRunStatus({ status: 'idle' }, t)).toBeNull()
  })

  it('mostra que está rodando', () => {
    expect(describeRunStatus({ status: 'running' }, t)).toEqual({ tone: 'accent', label: 'Executando' })
  })

  it('mostra código e duração da resposta, com tom de erro a partir de 400', () => {
    expect(describeRunStatus({ status: 'success', statusCode: 200, durationMs: 80 }, t)).toEqual({
      tone: 'success',
      label: '200',
      detail: '80 ms',
    })
    expect(describeRunStatus({ status: 'success', statusCode: 404, durationMs: 12 }, t)?.tone).toBe('error')
  })

  it('mostra o ramo tomado pelo if', () => {
    expect(describeRunStatus({ status: 'branched', result: true }, t)).toEqual({ tone: 'success', label: 'Verdadeiro' })
    expect(describeRunStatus({ status: 'branched', result: false }, t)).toEqual({ tone: 'neutral', label: 'Falso' })
  })

  it('mostra falha sem a mensagem, que vai para a faixa de erro', () => {
    expect(describeRunStatus({ status: 'failed', message: 'boom' }, t)).toEqual({ tone: 'error', label: 'Falhou' })
  })

  it('mostra a iteração e o total do while', () => {
    expect(describeRunStatus({ status: 'looping', iteration: 3 }, t)).toEqual({ tone: 'accent', label: 'Iteração 3' })
    expect(describeRunStatus({ status: 'loopFinished', iterations: 5 }, t)).toEqual({ tone: 'success', label: '5 iterações' })
  })

  it('mostra conclusão de node sem resposta HTTP', () => {
    expect(describeRunStatus({ status: 'completed', message: null }, t)).toEqual({ tone: 'success', label: 'Concluído' })
  })

  it('distingue cada motivo de node pulado', () => {
    expect(describeRunStatus({ status: 'skipped', reason: 'cancelled' }, t)).toEqual({ tone: 'warning', label: 'Cancelado' })
    expect(describeRunStatus({ status: 'skipped', reason: 'branchNotTaken' }, t)).toEqual({ tone: 'neutral', label: 'Ramo não seguido' })
    expect(describeRunStatus({ status: 'skipped', reason: 'loopInterrupted' }, t)).toEqual({
      tone: 'neutral',
      label: 'Interrompido pelo loop',
    })
    expect(describeRunStatus({ status: 'skipped', reason: 'unreachable' }, t)).toEqual({ tone: 'neutral', label: 'Não alcançável' })
    expect(describeRunStatus({ status: 'cancelled' }, t)).toEqual({ tone: 'warning', label: 'Cancelado' })
  })
})

describe('runStateClass', () => {
  it('marca como ativo enquanto roda ou itera', () => {
    expect(runStateClass({ status: 'running' }, true)).toBe('flow-node--active')
    expect(runStateClass({ status: 'looping', iteration: 1 }, false)).toBe('flow-node--active')
  })

  it('esmaece o node pulado', () => {
    expect(runStateClass({ status: 'skipped', reason: 'branchNotTaken' }, false)).toBe('flow-node--skipped')
  })

  it('combina falha com o rastro do run', () => {
    expect(runStateClass({ status: 'failed', message: 'x' }, true)).toBe('flow-node--failed flow-node--visited')
    expect(runStateClass({ status: 'success', statusCode: 200, durationMs: 1 }, true)).toBe('flow-node--visited')
    expect(runStateClass({ status: 'idle' }, false)).toBe('')
  })
})
