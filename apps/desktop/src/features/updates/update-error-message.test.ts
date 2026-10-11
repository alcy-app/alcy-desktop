import { describe, expect, it } from 'vitest'
import { translate, type TranslationKey, type TranslationParams } from '../../shared/i18n/translations'
import { updateErrorMessage } from './update-error-message'

const ptBR = (key: TranslationKey, params?: TranslationParams) => translate('pt-BR', key, params)

describe('updateErrorMessage', () => {
  it('backup que falhou explica que a atualização não foi instalada', () => {
    expect(updateErrorMessage({ kind: 'backup', message: 'disco cheio' }, ptBR)).toBe(
      'Não foi possível fazer o backup dos workspaces, então a atualização não foi instalada: disco cheio',
    )
  })
})
