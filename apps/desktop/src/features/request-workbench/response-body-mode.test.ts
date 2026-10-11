import { describe, expect, it } from 'vitest'
import { detectBodyMode } from './response-body-mode'

describe('detectBodyMode', () => {
  it('detecta json pelo Content-Type, mesmo com parâmetro charset', () => {
    expect(detectBodyMode([{ name: 'Content-Type', value: 'application/json; charset=utf-8' }], 'não importa')).toBe(
      'json',
    )
  })

  it('detecta json por um Content-Type +json', () => {
    expect(detectBodyMode([{ name: 'Content-Type', value: 'application/vnd.api+json' }], 'não importa')).toBe('json')
  })

  it('detecta xml pelo Content-Type application/xml ou text/xml', () => {
    expect(detectBodyMode([{ name: 'Content-Type', value: 'application/xml' }], '<a/>')).toBe('xml')
    expect(detectBodyMode([{ name: 'Content-Type', value: 'text/xml' }], '<a/>')).toBe('xml')
  })

  it('detecta xml por um Content-Type +xml', () => {
    expect(detectBodyMode([{ name: 'Content-Type', value: 'application/atom+xml' }], '<a/>')).toBe('xml')
  })

  it('busca o header Content-Type ignorando maiúsculas/minúsculas do nome', () => {
    expect(detectBodyMode([{ name: 'content-type', value: 'application/json' }], '{}')).toBe('json')
  })

  it('detecta html pelo Content-Type text/html ou application/xhtml+xml', () => {
    expect(detectBodyMode([{ name: 'Content-Type', value: 'text/html; charset=utf-8' }], '<p>oi</p>')).toBe('html')
    expect(detectBodyMode([{ name: 'Content-Type', value: 'application/xhtml+xml' }], '<p>oi</p>')).toBe('html')
  })

  it('sem Content-Type, faz sniff pelo corpo: DOCTYPE/<html> vira html, não xml genérico', () => {
    expect(detectBodyMode([], '<!DOCTYPE html><html><body>oi</body></html>')).toBe('html')
    expect(detectBodyMode([], '<html><body>oi</body></html>')).toBe('html')
    expect(detectBodyMode([], '<config><item/></config>')).toBe('xml')
  })

  it('cai em texto puro para um Content-Type explícito de texto', () => {
    expect(detectBodyMode([{ name: 'Content-Type', value: 'text/csv' }], '{"a":1}')).toBe('text')
  })

  it('sem Content-Type, faz sniff pelo corpo: JSON válido vira json', () => {
    expect(detectBodyMode([], '{"a":1}')).toBe('json')
  })

  it('sem Content-Type, faz sniff pelo corpo: começa com "<" vira xml', () => {
    expect(detectBodyMode([], '<a>1</a>')).toBe('xml')
  })

  it('sem Content-Type e sem parecer json/xml, cai em texto puro', () => {
    expect(detectBodyMode([], 'texto qualquer')).toBe('text')
  })

  it('Content-Type genérico (text/plain) também cai no sniff pelo corpo', () => {
    expect(detectBodyMode([{ name: 'Content-Type', value: 'text/plain' }], '{"a":1}')).toBe('json')
    expect(detectBodyMode([{ name: 'Content-Type', value: 'text/plain' }], 'oi')).toBe('text')
  })
})
