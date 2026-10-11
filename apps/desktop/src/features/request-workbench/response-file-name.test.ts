import { describe, expect, it } from 'vitest'
import { responseFileName } from './response-file-name'

const contentType = (value: string) => [{ name: 'Content-Type', value }]

describe('responseFileName', () => {
  it('usa o nome da requisição com a extensão do Content-Type', () => {
    expect(responseFileName('Listar usuários', contentType('application/json; charset=utf-8'), 'text')).toBe('Listar usuários.json')
    expect(responseFileName('Feed', contentType('application/atom+xml'), 'text')).toBe('Feed.xml')
    expect(responseFileName('Problema', contentType('application/problem+json'), 'text')).toBe('Problema.json')
    expect(responseFileName('Logo', contentType('image/png'), 'base64')).toBe('Logo.png')
  })

  it('cai em txt para texto e bin para binário sem Content-Type conhecido', () => {
    expect(responseFileName('Req', [], 'text')).toBe('Req.txt')
    expect(responseFileName('Req', contentType('application/octet-stream'), 'base64')).toBe('Req.bin')
  })

  it('usa "response" quando a requisição não tem nome aproveitável', () => {
    expect(responseFileName('  ', contentType('text/html'), 'text')).toBe('response.html')
  })

  it('troca caracteres inválidos em nome de arquivo', () => {
    expect(responseFileName('GET /users/:id?', contentType('application/json'), 'text')).toBe('GET -users--id-.json')
  })

  it('prefere o nome do Content-Disposition', () => {
    const headers = [...contentType('application/pdf'), { name: 'content-disposition', value: 'attachment; filename="relatorio final.pdf"' }]
    expect(responseFileName('Req', headers, 'base64')).toBe('relatorio final.pdf')
  })

  it('lê a forma estendida filename* do Content-Disposition', () => {
    const headers = [{ name: 'Content-Disposition', value: "attachment; filename=fallback.csv; filename*=UTF-8''relat%C3%B3rio.csv" }]
    expect(responseFileName('Req', headers, 'text')).toBe('relatório.csv')
  })

  it('não deixa o Content-Disposition escapar do diretório escolhido', () => {
    const headers = [{ name: 'Content-Disposition', value: 'attachment; filename="../../etc/passwd"' }]
    expect(responseFileName('Req', headers, 'text')).toBe('-..-etc-passwd')
  })
})
