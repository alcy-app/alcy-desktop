import { describe, expect, it } from 'vitest'
import { importDropPathName, isImportDropPath } from './import-drop'

describe('isImportDropPath', () => {
  it('aceita imagens compartilhadas', () => {
    expect(isImportDropPath('/tmp/Listar usuários.PNG')).toBe(true)
  })

  it('aceita os formatos do diálogo de importação', () => {
    for (const path of ['/tmp/a.json', '/tmp/a.yaml', '/tmp/a.yml', '/tmp/a.har', '/tmp/a.bru', '/tmp/a.sh', '/tmp/a.txt']) {
      expect(isImportDropPath(path)).toBe(true)
    }
  })

  it('aceita pastas sem extensão', () => {
    expect(isImportDropPath('/tmp/Minha API')).toBe(true)
    expect(isImportDropPath('/tmp/Minha API/')).toBe(true)
    expect(isImportDropPath('C:\\Users\\eu\\Minha API')).toBe(true)
  })

  it('ignora arquivos sem formato importável', () => {
    expect(isImportDropPath('/tmp/foto.jpg')).toBe(false)
    expect(isImportDropPath('/tmp/documento.pdf')).toBe(false)
    expect(isImportDropPath('/tmp/script.py')).toBe(false)
  })
})

describe('importDropPathName', () => {
  it('devolve o último segmento do caminho', () => {
    expect(importDropPathName('/tmp/pasta/arquivo.json')).toBe('arquivo.json')
    expect(importDropPathName('C:\\pasta\\arquivo.json')).toBe('arquivo.json')
  })
})
