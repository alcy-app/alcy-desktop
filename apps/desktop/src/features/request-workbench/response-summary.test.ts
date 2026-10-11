import { describe, expect, it } from 'vitest'
import { translate, type TranslationKey, type TranslationParams } from '../../shared/i18n/translations'
import { describeError, errorDetail, formatElapsed } from './response-summary'

const en = (key: TranslationKey, params?: TranslationParams) => translate('en', key, params)
const ptBR = (key: TranslationKey, params?: TranslationParams) => translate('pt-BR', key, params)

describe('describeError', () => {
  it('descreve a causa reconhecida no idioma da interface, sem a mensagem do backend', () => {
    const error = {
      kind: 'invalidRequest',
      message: "variável 'baseUrl' não definida no ambiente ativo",
      cause: { type: 'missingVariable', name: 'baseUrl' },
    } as const

    expect(describeError(en, error)).toBe(
      'The variable {{baseUrl}} is not defined in the active environment, collection or folder.',
    )
    expect(describeError(ptBR, error)).toBe(
      'A variável {{baseUrl}} não está definida no ambiente ativo, na coleção ou na pasta.',
    )
  })

  it('usa os parâmetros da causa de rede', () => {
    const error = {
      kind: 'network',
      message: 'OAuth2 token endpoint responded with status 401 Unauthorized',
      cause: { type: 'oauth2TokenStatus', status: 401 },
    } as const

    expect(describeError(en, error)).toContain('the token server responded with status 401')
  })

  it('cai na mensagem do backend quando não há causa reconhecida', () => {
    expect(describeError(en, { kind: 'network', message: 'connection reset' })).toBe('Network failure: connection reset')
  })
})

describe('errorDetail', () => {
  it('mostra o detalhe técnico das falhas de rede com causa', () => {
    const detail = 'error sending request: tcp connect error: Connection refused (os error 111)'
    expect(errorDetail({ kind: 'network', message: detail, cause: { type: 'connectionRefused' } })).toBe(detail)
  })

  it('não repete a mensagem quando ela já está na descrição', () => {
    expect(errorDetail({ kind: 'network', message: 'connection reset' })).toBeNull()
  })

  it('omite a mensagem do backend das causas de requisição que se explicam sozinhas', () => {
    expect(
      errorDetail({ kind: 'invalidRequest', message: 'endpoint URL não pode ser vazio', cause: { type: 'emptyEndpoint' } }),
    ).toBeNull()
    expect(
      errorDetail({
        kind: 'invalidRequest',
        message: 'No such file or directory (os error 2)',
        cause: { type: 'bodyFileUnreadable', path: '/tmp/a.json' },
      }),
    ).toBe('No such file or directory (os error 2)')
  })
})

describe('formatElapsed', () => {
  it('mostra décimos de segundo abaixo de um minuto, sem arredondar para cima', () => {
    expect(formatElapsed(0)).toBe('0.0 s')
    expect(formatElapsed(99)).toBe('0.0 s')
    expect(formatElapsed(2_490)).toBe('2.4 s')
    expect(formatElapsed(59_999)).toBe('59.9 s')
  })

  it('passa para minutos e segundos a partir de um minuto', () => {
    expect(formatElapsed(60_000)).toBe('1m 00s')
    expect(formatElapsed(65_400)).toBe('1m 05s')
    expect(formatElapsed(754_000)).toBe('12m 34s')
  })

  it('trata relógio retroativo como zero', () => {
    expect(formatElapsed(-500)).toBe('0.0 s')
  })
})
