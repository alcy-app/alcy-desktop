import { describe, expect, it } from 'vitest'
import type { ReleaseDto } from '../../bindings/update-types'
import { updateNotifications } from './update-notification'

const RELEASE: ReleaseDto = {
  version: '0.2.0',
  name: null,
  notes: null,
  publishedAt: '2026-09-01T12:00:00Z',
  webUrl: 'https://git.example.com/grupo/alcy/-/releases/v0.2.0',
  installable: true,
}

describe('updateNotifications', () => {
  it('não gera aviso sem versão nova', () => {
    expect(updateNotifications({ kind: 'idle' })).toEqual([])
    expect(updateNotifications({ kind: 'upToDate' })).toEqual([])
  })

  it('gera um aviso por versão, com link para a release', () => {
    const [notification] = updateNotifications({ kind: 'available', release: RELEASE })

    expect(notification.id).toBe('update:0.2.0')
    expect(notification.kind).toBe('update')
    expect(notification.date).toBe('2026-09-01')
    expect(notification.title['pt-BR']).toBe('Alcy 0.2.0 disponível')
    expect(notification.title.en).toBe('Alcy 0.2.0 available')
    expect(notification.message['pt-BR']).toContain(`[Ver release](${RELEASE.webUrl})`)
  })

  it('usa a data de hoje quando a release não informa a publicação', () => {
    const [notification] = updateNotifications(
      { kind: 'ready', release: { ...RELEASE, publishedAt: null, webUrl: null } },
      new Date('2026-09-24T10:00:00Z'),
    )

    expect(notification.date).toBe('2026-09-24')
    expect(notification.message.en).not.toContain('](')
  })

  it('leva as notas da release como detalhes, nos dois idiomas', () => {
    const [notification] = updateNotifications({
      kind: 'available',
      release: { ...RELEASE, notes: '  ## Novidades\n\n- Aba de detalhes\n' },
    })

    expect(notification.details).toEqual({ 'pt-BR': '## Novidades\n\n- Aba de detalhes', en: '## Novidades\n\n- Aba de detalhes' })
  })

  it('não gera detalhes sem notas', () => {
    for (const notes of [null, '  \n']) {
      const [notification] = updateNotifications({ kind: 'available', release: { ...RELEASE, notes } })
      expect(notification.details).toBeUndefined()
    }
  })
})
