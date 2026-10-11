import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const writeFrontendLogs = vi.fn()
vi.mock('../../bindings/write-frontend-logs', () => ({ writeFrontendLogs: (...args: unknown[]) => writeFrontendLogs(...args) }))

import { flushLogs, logger, scrubUrls } from './logger'

describe('logger', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    writeFrontendLogs.mockReset()
  })
  afterEach(() => {
    flushLogs()
    vi.useRealTimers()
  })

  it('agrupa eventos e envia um único lote após o intervalo', () => {
    logger.info('tabs', 'aba aberta')
    logger.warn('tabs', 'aba fechada', { count: 2 })
    expect(writeFrontendLogs).not.toHaveBeenCalled()

    vi.advanceTimersByTime(2000)

    expect(writeFrontendLogs).toHaveBeenCalledTimes(1)
    expect(writeFrontendLogs).toHaveBeenCalledWith([
      { level: 'info', scope: 'tabs', message: 'aba aberta' },
      { level: 'warn', scope: 'tabs', message: 'aba fechada {"count":2}' },
    ])
  })

  it('envia na hora quando o evento é um erro', () => {
    logger.error('window', 'falhou', new Error('boom'))
    expect(writeFrontendLogs).toHaveBeenCalledWith([{ level: 'error', scope: 'window', message: 'falhou Error: boom' }])
  })

  it('trunca mensagens longas', () => {
    logger.info('x', 'a'.repeat(5000))
    flushLogs()
    const [[batch]] = writeFrontendLogs.mock.calls as [[Array<{ message: string }>]]
    expect(batch[0].message.length).toBeLessThanOrEqual(1501)
  })

  it('corta query string e fragmento de URLs', () => {
    expect(scrubUrls('falha em https://api.x.com/v1/a?token=abc#frag fim')).toBe('falha em https://api.x.com/v1/a?… fim')
    expect(scrubUrls('sem url')).toBe('sem url')
  })
})
