import { describe, expect, it } from 'vitest'
import { extractReleaseNotes, releaseNotesNotification } from './release-notes'
import { markReleaseNotesSeen } from './release-notes-storage'

const CHANGELOG = `# Changelog

Introdução.

## [Unreleased]

### Adicionado

- Em andamento.

## [0.4.0-beta.1] - 30/09/2026

### Adicionado

- **Histórico de envios**: lista os envios.

## [0.3.1] - 2026-09-29

### Corrigido

- Correção do patch.

## [0.3.0] - 2026-09-28

### Adicionado

- Novidade do minor.

## [0.2.0] - 2026-09-25

### Corrigido

- Correção.

## [0.1.0]

[0.2.0]: https://git.example.com/alcy/-/releases/v0.2.0
`

describe('extractReleaseNotes', () => {
  it('extrai só a seção da versão, com a data em ISO', () => {
    expect(extractReleaseNotes(CHANGELOG, '0.4.0-beta.1')).toEqual({
      version: '0.4.0-beta.1',
      date: '2026-09-30',
      body: '### Adicionado\n\n- **Histórico de envios**: lista os envios.',
    })
    expect(extractReleaseNotes(CHANGELOG, '0.2.0')).toEqual({ version: '0.2.0', date: '2026-09-25', body: '### Corrigido\n\n- Correção.' })
  })

  it('inclui os patches do mesmo minor, do mais novo para o inicial', () => {
    expect(extractReleaseNotes(CHANGELOG, '0.3.1')).toEqual({
      version: '0.3.1',
      date: '2026-09-29',
      body: `## [0.3.1] - 2026-09-29

### Corrigido

- Correção do patch.

## [0.3.0] - 2026-09-28

### Adicionado

- Novidade do minor.`,
    })
  })

  it('ignora versões sem seção ou sem conteúdo', () => {
    expect(extractReleaseNotes(CHANGELOG, '9.9.9')).toBeNull()
    // A seção 0.1.0 só tem definições de link do rodapé.
    expect(extractReleaseNotes(CHANGELOG, '0.1.0')).toBeNull()
  })

  it('usa Unreleased como reserva só quando pedido', () => {
    expect(extractReleaseNotes(CHANGELOG, '0.4.1')).toBeNull()
    expect(extractReleaseNotes(CHANGELOG, '0.4.1', true)).toEqual({
      version: '0.4.1',
      date: null,
      body: '### Adicionado\n\n- Em andamento.',
    })
  })
})

describe('releaseNotesNotification', () => {
  it('vira uma aba de atualização com as notas nos dois idiomas', () => {
    const notification = releaseNotesNotification({ version: '0.2.0', date: '2026-09-25', body: '- Correção.' })

    expect(notification).toMatchObject({
      id: 'release-notes:0.2.0',
      kind: 'update',
      date: '2026-09-25',
      title: { 'pt-BR': 'Novidades da versão 0.2.0', en: 'What is new in 0.2.0' },
      details: { 'pt-BR': '- Correção.', en: '- Correção.' },
    })
  })
})

describe('markReleaseNotesSeen', () => {
  it('só devolve true na primeira abertura de cada versão', () => {
    window.localStorage.removeItem('alcy:release-notes:seen-version')

    expect(markReleaseNotesSeen('0.4.0')).toBe(true)
    expect(markReleaseNotesSeen('0.4.0')).toBe(false)
    expect(markReleaseNotesSeen('0.4.1')).toBe(true)
  })
})
