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

  it('batches events and sends them after the interval', () => {
    logger.info('tabs', 'tab opened')
    logger.warn('tabs', 'tab closed', { count: 2 })
    expect(writeFrontendLogs).not.toHaveBeenCalled()

    vi.advanceTimersByTime(2000)

    expect(writeFrontendLogs).toHaveBeenCalledTimes(1)
    expect(writeFrontendLogs).toHaveBeenCalledWith([
      { level: 'info', scope: 'tabs', message: 'tab opened' },
      { level: 'warn', scope: 'tabs', message: 'tab closed {"count":2}' },
    ])
  })

  it('sends errors immediately', () => {
    logger.error('window', 'failed', new Error('boom'))
    expect(writeFrontendLogs).toHaveBeenCalledWith([{ level: 'error', scope: 'window', message: 'failed Error: boom' }])
  })

  it('preserves nested error causes and removes URL credentials and queries', () => {
    logger.error('window', 'failed', new Error('request failed', {
      cause: new TypeError('connection refused at https://user:pass@api.example.com/a?token=abc#fragment'),
    }))
    expect(writeFrontendLogs).toHaveBeenCalledWith([{
      level: 'error',
      scope: 'window',
      message: 'failed Error: request failed; cause: TypeError: connection refused at https://api.example.com/a?…',
    }])
  })

  it('preserves errors nested in structured rejection reasons', () => {
    logger.error('window', 'failed', { reason: new Error('connection refused') })
    expect(writeFrontendLogs).toHaveBeenCalledWith([{
      level: 'error', scope: 'window', message: 'failed {"reason":"Error: connection refused"}',
    }])
  })

  it('bounds cyclic error causes', () => {
    const error = new Error('request failed')
    error.cause = { reason: error }
    logger.error('window', 'failed', error)
    expect(writeFrontendLogs).toHaveBeenCalledWith([{
      level: 'error', scope: 'window', message: 'failed Error: request failed; cause: {"reason":"…"}',
    }])
  })

  it('omits request data attached to error causes', () => {
    logger.error('window', 'failed', new Error('request failed', {
      cause: { reason: 'connection refused', headers: { authorization: 'sensitive' }, body: 'sensitive' },
    }))
    expect(writeFrontendLogs).toHaveBeenCalledWith([{
      level: 'error', scope: 'window', message: 'failed Error: request failed; cause: {"reason":"connection refused"}',
    }])
  })

  it('truncates long messages', () => {
    logger.info('x', 'a'.repeat(5000))
    flushLogs()
    const [[batch]] = writeFrontendLogs.mock.calls as [[Array<{ message: string }>]]
    expect(batch[0].message.length).toBeLessThanOrEqual(1501)
  })

  it('strips URL query strings and fragments', () => {
    expect(scrubUrls('failure at https://api.x.com/v1/a?token=abc#frag end')).toBe('failure at https://api.x.com/v1/a?… end')
    expect(scrubUrls('no URL')).toBe('no URL')
  })
})
