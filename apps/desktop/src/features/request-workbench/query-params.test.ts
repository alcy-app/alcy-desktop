import { describe, expect, it } from 'vitest'
import {
  applyRouteParamValues,
  buildUrlWithParams,
  findRouteParamRanges,
  parseQueryParams,
  parseRouteParams,
  removeRouteParamFromUrl,
  renameRouteParamInUrl,
} from './query-params'

describe('parseRouteParams', () => {
  it('extrai parâmetros somente do caminho e ignora esquema, porta, query e fragmento', () => {
    expect(parseRouteParams('https://api.test:8443/users/:userId/orders/:order-id?next=/:ignored#/:ignored')).toEqual([
      { name: 'userId' },
      { name: 'order-id' },
    ])
  })

  it('informa os intervalos exatos usados pelo destaque visual', () => {
    const url = 'https://api.test:8443/users/:userId/orders/:order-id?next=/:ignored'
    expect(
      findRouteParamRanges(url).map(({ name, start, end }) => ({
        name,
        token: url.slice(start, end),
      })),
    ).toEqual([
      { name: 'userId', token: ':userId' },
      { name: 'order-id', token: ':order-id' },
    ])
  })

  it('aplica o valor em todas as ocorrências sem alterar query ou fragmento', () => {
    expect(
      applyRouteParamValues('https://api.test/users/:id/orders/:id?next=/:id#/:id', [
        { name: 'id', value: '42' },
      ]),
    ).toBe('https://api.test/users/42/orders/42?next=/:id#/:id')
  })

  it('remove todas as ocorrências do mesmo route param e preserva a query', () => {
    expect(removeRouteParamFromUrl('https://api.test/users/:id/orders/:id?next=/:id', 'id')).toBe(
      'https://api.test/users/orders?next=/:id',
    )
  })

  it('renomeia todas as ocorrências do mesmo route param e preserva query e fragmento', () => {
    expect(renameRouteParamInUrl('https://api.test/users/:id/orders/:id?next=/:id#/:id', 'id', 'userId')).toBe(
      'https://api.test/users/:userId/orders/:userId?next=/:id#/:id',
    )
  })

  it('normaliza o nome ao renomear um route param', () => {
    expect(renameRouteParamInUrl('https://api.test/users/:id', 'id', ':user id!')).toBe('https://api.test/users/:userid')
  })

  it('mantém apenas a primeira ocorrência de nomes repetidos', () => {
    expect(parseRouteParams('{{baseUrl}}/teams/:id/users/:id')).toEqual([{ name: 'id' }])
  })

  it('ignora dois-pontos que não iniciam um segmento do caminho', () => {
    expect(parseRouteParams('https://api.test/users/prefix:id')).toEqual([])
  })
})

describe('parseQueryParams', () => {
  it('retorna vazio quando a URL não tem query string', () => {
    expect(parseQueryParams('{{baseUrl}}/users')).toEqual([])
    expect(parseQueryParams('{{baseUrl}}/users?')).toEqual([])
  })

  it('separa múltiplos pares nome/valor', () => {
    expect(parseQueryParams('{{baseUrl}}/users?page=2&limit=10')).toEqual([
      { name: 'page', value: '2' },
      { name: 'limit', value: '10' },
    ])
  })

  it('preserva valores contendo "=" (só divide no primeiro)', () => {
    expect(parseQueryParams('{{baseUrl}}/x?filter=a=b')).toEqual([{ name: 'filter', value: 'a=b' }])
  })

  it('trata um par sem "=" como nome com valor vazio', () => {
    expect(parseQueryParams('{{baseUrl}}/x?flag')).toEqual([{ name: 'flag', value: '' }])
  })

  it('não decodifica nem interpola placeholders {{var}}', () => {
    expect(parseQueryParams('{{baseUrl}}/x?token={{apiToken}}&q=a%20b')).toEqual([
      { name: 'token', value: '{{apiToken}}' },
      { name: 'q', value: 'a%20b' },
    ])
  })
})

describe('buildUrlWithParams', () => {
  it('anexa a query string dos parâmetros habilitados com nome não vazio', () => {
    const url = buildUrlWithParams('{{baseUrl}}/users', [
      { name: 'page', value: '2', enabled: true },
      { name: 'limit', value: '10', enabled: true },
    ])
    expect(url).toBe('{{baseUrl}}/users?page=2&limit=10')
  })

  it('exclui parâmetros desabilitados mas os mantém fora da URL (não são apagados pelo chamador)', () => {
    const url = buildUrlWithParams('{{baseUrl}}/users?page=2&limit=10', [
      { name: 'page', value: '2', enabled: false },
      { name: 'limit', value: '10', enabled: true },
    ])
    expect(url).toBe('{{baseUrl}}/users?limit=10')
  })

  it('reinclui um parâmetro reabilitado', () => {
    const url = buildUrlWithParams('{{baseUrl}}/users?limit=10', [
      { name: 'page', value: '2', enabled: true },
      { name: 'limit', value: '10', enabled: true },
    ])
    expect(url).toBe('{{baseUrl}}/users?page=2&limit=10')
  })

  it('exclui parâmetros com nome vazio', () => {
    const url = buildUrlWithParams('{{baseUrl}}/users', [{ name: '', value: 'x', enabled: true }])
    expect(url).toBe('{{baseUrl}}/users')
  })

  it('remove o "?" por completo quando não sobra nenhum parâmetro', () => {
    const url = buildUrlWithParams('{{baseUrl}}/users?page=2', [{ name: 'page', value: '2', enabled: false }])
    expect(url).toBe('{{baseUrl}}/users')
  })

  it('preserva tudo antes do primeiro "?" inalterado', () => {
    const url = buildUrlWithParams('{{baseUrl}}/users?a=1', [{ name: 'b', value: '2', enabled: true }])
    expect(url).toBe('{{baseUrl}}/users?b=2')
  })
})
