import { describe, expect, it } from 'vitest'
import { timeColumnStyle } from './console-entry-presentation'

const width = (formatter: Intl.DateTimeFormat) =>
  (timeColumnStyle(formatter) as Record<string, string>)['--console-time-width']

describe('timeColumnStyle', () => {
  it('reserva espaço para o sufixo AM/PM no formato de 12 horas', () => {
    const options: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', second: '2-digit' }
    const twelveHour = new Intl.DateTimeFormat('en-US', { ...options, hour12: true })
    const twentyFourHour = new Intl.DateTimeFormat('en-US', { ...options, hour12: false })

    expect(width(twelveHour)).toBe(`${twelveHour.format(new Date(2000, 0, 1, 22, 22, 22)).length}ch`)
    expect(parseInt(width(twelveHour))).toBeGreaterThan(parseInt(width(twentyFourHour)))
  })

  it('conta os milissegundos quando o formatador os inclui', () => {
    const formatter = new Intl.DateTimeFormat('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3,
    })

    expect(width(formatter)).toBe('12ch')
  })
})
