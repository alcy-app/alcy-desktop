import { describe, expect, it } from 'vitest'
import {
  assignShortcut,
  comboFromEvent,
  comboFromMouseEvent,
  DEFAULT_SHORTCUTS,
  findConflict,
  findShortcutAction,
  formatCombo,
  isLocalAction,
  isShortcutEventConsumed,
  isShortcutFor,
  sameCombo,
  SHORTCUT_ACTIONS,
  parseCombo,
  readStoredShortcuts,
  removeShortcut,
  resetShortcut,
  SHORTCUTS_STORAGE_KEY,
  validateCombo,
  writeStoredShortcuts,
  yieldShortcutToWorkbench,
  type KeyCombo,
} from './shortcuts'

const keyEvent = (key: string, modifiers: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...modifiers,
})

const combo = (text: string): KeyCombo => {
  const parsed = parseCombo(text)
  if (!parsed) throw new Error(`combinação inválida no teste: ${text}`)
  return parsed
}

const store = (value: unknown) => window.localStorage.setItem(SHORTCUTS_STORAGE_KEY, JSON.stringify(value))

describe('combinações', () => {
  it('formata na ordem canônica e lê de volta em qualquer ordem', () => {
    expect(formatCombo(combo('Shift+Ctrl+Tab'))).toBe('Ctrl+Shift+Tab')
    expect(formatCombo(combo('Alt+s'))).toBe('Alt+S')
    expect(formatCombo(combo('Ctrl++'))).toBe('Ctrl++')
    expect(parseCombo('Ctrl+')).toBeNull()
    expect(parseCombo('Ctrl+Ctrl+S')).toBeNull()
    expect(parseCombo('Super+S')).toBeNull()
    expect(parseCombo('Ctrl+Shift')).toBeNull()
  })

  it('lê a combinação do evento, tratando Cmd como Ctrl e ignorando modificador sozinho', () => {
    expect(comboFromEvent(keyEvent('Control', { ctrlKey: true }))).toBeNull()
    expect(formatCombo(comboFromEvent(keyEvent('s', { metaKey: true }))!)).toBe('Ctrl+S')
    expect(formatCombo(comboFromEvent(keyEvent('S', { ctrlKey: true, shiftKey: true }))!)).toBe('Ctrl+Shift+S')
    expect(formatCombo(comboFromEvent(keyEvent(' ', { altKey: true }))!)).toBe('Alt+Space')
  })

  it('aceita Enter e F-keys sem modificador e recusa digitação e combinações de edição', () => {
    expect(validateCombo(combo('Enter'), 'sendRequest')).toBe('ok')
    expect(validateCombo(combo('Shift+F5'), 'sendRequest')).toBe('ok')
    expect(validateCombo(combo('Ctrl+Enter'), 'sendRequest')).toBe('ok')
    expect(validateCombo(combo('A'), 'sendRequest')).toBe('needsModifier')
    expect(validateCombo(combo('Tab'), 'sendRequest')).toBe('needsModifier')
    expect(validateCombo(combo('Shift+A'), 'sendRequest')).toBe('needsModifier')
    expect(validateCombo(combo('Ctrl+Z'), 'sendRequest')).toBe('reserved')
    expect(validateCombo(combo('Ctrl+V'), 'sendRequest')).toBe('reserved')
    expect(validateCombo(combo('Escape'), 'sendRequest')).toBe('reserved')
  })

  it('aceita Tab sem modificador só nas ações dos editores, que ficam com o próprio editor', () => {
    expect(validateCombo(combo('Tab'), 'acceptSuggestion')).toBe('ok')
    expect(validateCombo(combo('Enter'), 'acceptSuggestion')).toBe('ok')
    expect(validateCombo(combo('A'), 'acceptSuggestion')).toBe('needsModifier')
    expect(validateCombo(combo('Tab'), 'renameItem')).toBe('needsModifier')
    expect(DEFAULT_SHORTCUTS.acceptSuggestion.map(formatCombo)).toEqual(['Tab'])
    expect(DEFAULT_SHORTCUTS.showSuggestions.map(formatCombo)).toEqual(['Ctrl+Space'])
    expect(isLocalAction('showSuggestions')).toBe(true)
    expect(isLocalAction('acceptSuggestion')).toBe(true)
  })
})

describe('atribuições', () => {
  it('encontra a ação de um evento por qualquer um dos atalhos', () => {
    const bindings = { ...DEFAULT_SHORTCUTS, saveRequest: [combo('Ctrl+S'), combo('F4')] }
    expect(findShortcutAction(bindings, keyEvent('F4'))).toBe('saveRequest')
    expect(findShortcutAction(bindings, keyEvent('s', { ctrlKey: true }))).toBe('saveRequest')
    expect(findShortcutAction(bindings, keyEvent('Tab', { ctrlKey: true, shiftKey: true }))).toBe('previousTab')
    expect(findShortcutAction(bindings, keyEvent('Enter', { shiftKey: true }))).toBeNull()
  })

  it('aponta o conflito com outra ação, mas não com a própria', () => {
    expect(findConflict(DEFAULT_SHORTCUTS, combo('Ctrl+S'), 'sendRequest')).toBe('saveRequest')
    expect(findConflict(DEFAULT_SHORTCUTS, combo('Ctrl+S'), 'saveRequest')).toBeNull()
  })

  it('troca, adiciona até dois e tira a combinação de outra ação', () => {
    let bindings = assignShortcut(removeShortcut(DEFAULT_SHORTCUTS, 'sendRequest', 1), 'sendRequest', 1, combo('F5'))
    expect(bindings.sendRequest.map(formatCombo)).toEqual(['Enter', 'F5'])
    expect(assignShortcut(bindings, 'sendRequest', 2, combo('F6'))).toBe(bindings)
    expect(assignShortcut(bindings, 'sendRequest', 0, combo('F5'))).toBe(bindings)

    bindings = assignShortcut(bindings, 'sendRequest', 0, combo('Ctrl+S'))
    expect(bindings.sendRequest.map(formatCombo)).toEqual(['Ctrl+S', 'F5'])
    expect(bindings.saveRequest).toEqual([])
  })

  it('remove um atalho e restaura o padrão tirando-o de quem o pegou', () => {
    let bindings = removeShortcut(DEFAULT_SHORTCUTS, 'saveRequest', 0)
    expect(bindings.saveRequest).toEqual([])
    bindings = assignShortcut(bindings, 'nextTab', 1, combo('Ctrl+S'))
    bindings = resetShortcut(bindings, 'saveRequest')
    expect(bindings.saveRequest.map(formatCombo)).toEqual(['Ctrl+S'])
    expect(bindings.nextTab.map(formatCombo)).toEqual(['Ctrl+Tab'])
  })
})

describe('renomear item', () => {
  it('usa F2 por padrão, aceita troca por teclado e é despachada pelo item focado', () => {
    expect(isShortcutFor(DEFAULT_SHORTCUTS, 'renameItem', comboFromEvent(keyEvent('F2')))).toBe(true)
    expect(findShortcutAction(DEFAULT_SHORTCUTS, keyEvent('F2'))).toBe('renameItem')
    expect(validateCombo(combo('Ctrl+R'), 'renameItem')).toBe('ok')
    expect(validateCombo(combo('MouseLeft'), 'renameItem')).toBe('mouseNotAllowed')
    expect(isLocalAction('renameItem')).toBe(true)
    expect(isLocalAction('saveRequest')).toBe(false)
  })
})

describe('padrões', () => {
  it('são válidos para a própria ação e não repetem combinação entre ações', () => {
    const all = SHORTCUT_ACTIONS.flatMap((action) => DEFAULT_SHORTCUTS[action].map((bound) => ({ action, bound })))
    for (const { action, bound } of all) expect(validateCombo(bound, action)).toBe('ok')
    for (const { action, bound } of all) {
      expect(all.filter((other) => sameCombo(other.bound, bound)).map((other) => other.action)).toEqual([action])
    }
  })

  it('usam as teclas comuns entre clientes de API', () => {
    const defaults = (action: keyof typeof DEFAULT_SHORTCUTS) => DEFAULT_SHORTCUTS[action].map(formatCombo)
    expect(defaults('sendRequest')).toEqual(['Enter', 'Ctrl+Enter'])
    expect(defaults('newRequest')).toEqual(['Ctrl+N', 'Ctrl+T'])
    expect(defaults('closeTab')).toEqual(['Ctrl+W'])
    expect(defaults('importCollections')).toEqual(['Ctrl+O'])
    expect(defaults('renameItem')).toEqual(['F2', 'Ctrl+E'])
    expect(defaults('duplicateItem')).toEqual(['Ctrl+D'])
    expect(defaults('deleteItem')).toEqual(['Delete'])
    expect(defaults('toggleSidebar')).toEqual(['Ctrl+\\'])
    expect(defaults('openSettings')).toEqual(['Ctrl+,'])
  })

  it('aceita Delete sem modificador só nas ações do item focado, que a própria linha despacha', () => {
    expect(validateCombo(combo('Delete'), 'deleteItem')).toBe('ok')
    expect(validateCombo(combo('Delete'), 'renameItem')).toBe('ok')
    expect(validateCombo(combo('Delete'), 'sendRequest')).toBe('needsModifier')
    expect(validateCombo(combo('Delete'), 'acceptSuggestion')).toBe('needsModifier')
    expect(isLocalAction('deleteItem')).toBe(true)
    expect(isLocalAction('duplicateItem')).toBe(true)
    expect(isLocalAction('closeTab')).toBe(true)
    expect(isLocalAction('newCollection')).toBe(false)
  })
})

describe('tecla cedida por um editor', () => {
  it('vale como não consumida mesmo com preventDefault', () => {
    const consumed = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })
    consumed.preventDefault()
    expect(isShortcutEventConsumed(consumed)).toBe(true)

    const yielded = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })
    yieldShortcutToWorkbench(yielded)
    yielded.preventDefault()
    expect(isShortcutEventConsumed(yielded)).toBe(false)
    expect(isShortcutEventConsumed(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(false)
  })
})

describe('armazenamento', () => {
  it('usa os padrões sem valor salvo, com JSON inválido ou versão desconhecida', () => {
    expect(readStoredShortcuts()).toEqual(DEFAULT_SHORTCUTS)
    window.localStorage.setItem(SHORTCUTS_STORAGE_KEY, '{quebrado')
    expect(readStoredShortcuts()).toEqual(DEFAULT_SHORTCUTS)
    store({ version: 2, bindings: { saveRequest: ['F2'] } })
    expect(readStoredShortcuts()).toEqual(DEFAULT_SHORTCUTS)
  })

  it('volta ao padrão só a ação com lista inválida', () => {
    store({
      version: 1,
      bindings: { saveRequest: ['F2'], sendRequest: ['A'], nextTab: ['F3', 'F4', 'F6'], previousTab: [] },
    })
    const bindings = readStoredShortcuts()
    expect(bindings.saveRequest.map(formatCombo)).toEqual(['F2'])
    expect(bindings.sendRequest).toEqual(DEFAULT_SHORTCUTS.sendRequest)
    expect(bindings.nextTab).toEqual(DEFAULT_SHORTCUTS.nextTab)
    expect(bindings.previousTab).toEqual([])
  })

  it('um atalho salvo vence o padrão de outra ação', () => {
    store({ version: 1, bindings: { saveRequest: ['Ctrl+D'] } })
    const bindings = readStoredShortcuts()
    expect(bindings.saveRequest.map(formatCombo)).toEqual(['Ctrl+D'])
    expect(bindings.duplicateItem).toEqual([])
    expect(findShortcutAction(bindings, keyEvent('d', { ctrlKey: true }))).toBe('saveRequest')
  })

  it('grava só o que difere do padrão e apaga a chave quando tudo volta ao padrão', () => {
    writeStoredShortcuts(removeShortcut(DEFAULT_SHORTCUTS, 'previousTab', 0))
    expect(JSON.parse(window.localStorage.getItem(SHORTCUTS_STORAGE_KEY)!)).toEqual({
      version: 1,
      bindings: { previousTab: [] },
    })
    writeStoredShortcuts(DEFAULT_SHORTCUTS)
    expect(window.localStorage.getItem(SHORTCUTS_STORAGE_KEY)).toBeNull()
  })
})

describe('botões do mouse', () => {
  const click = (button: number, modifiers: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({
    button,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...modifiers,
  })

  it('lê o botão e os modificadores do clique, e ignora botões extras', () => {
    expect(formatCombo(comboFromMouseEvent(click(2))!)).toBe('MouseRight')
    expect(formatCombo(comboFromMouseEvent(click(0, { metaKey: true, shiftKey: true }))!)).toBe('Ctrl+Shift+MouseLeft')
    expect(formatCombo(comboFromMouseEvent(click(1))!)).toBe('MouseMiddle')
    expect(comboFromMouseEvent(click(3))).toBeNull()
    expect(formatCombo(combo('Alt+MouseRight'))).toBe('Alt+MouseRight')
  })

  it('aceita botão sem modificador só nas ações do canvas', () => {
    expect(validateCombo(combo('MouseRight'), 'openBlockPalette')).toBe('ok')
    expect(validateCombo(combo('Ctrl+MouseLeft'), 'openBlockPalette')).toBe('ok')
    expect(validateCombo(combo('Ctrl+B'), 'openBlockPalette')).toBe('ok')
    expect(validateCombo(combo('MouseRight'), 'sendRequest')).toBe('mouseNotAllowed')
  })

  it('abre o menu de blocos com o botão direito por padrão, sem aceitar outro modificador', () => {
    expect(isShortcutFor(DEFAULT_SHORTCUTS, 'openBlockPalette', comboFromMouseEvent(click(2)))).toBe(true)
    expect(isShortcutFor(DEFAULT_SHORTCUTS, 'openBlockPalette', comboFromMouseEvent(click(2, { ctrlKey: true })))).toBe(false)
    expect(isShortcutFor(DEFAULT_SHORTCUTS, 'openBlockPalette', comboFromMouseEvent(click(0)))).toBe(false)
    expect(isShortcutFor(DEFAULT_SHORTCUTS, 'openBlockPalette', null)).toBe(false)
  })

  it('grava e lê atalhos de mouse, descartando botão numa ação que não o aceita', () => {
    writeStoredShortcuts(assignShortcut(DEFAULT_SHORTCUTS, 'openBlockPalette', 0, combo('Ctrl+MouseRight')))
    expect(readStoredShortcuts().openBlockPalette.map(formatCombo)).toEqual(['Ctrl+MouseRight'])

    store({ version: 1, bindings: { saveRequest: ['MouseRight'] } })
    expect(readStoredShortcuts().saveRequest).toEqual(DEFAULT_SHORTCUTS.saveRequest)
  })
})
