import { describe, expect, it, vi } from 'vitest'

// These tests cover the app's own modules, whatever extensions a build adds.
vi.mock('../../extensions/registry', () => ({ EXTENSION_SIDEBAR_MODULES: [] }))

import {
  SIDEBAR_HIDDEN_MODULES_STORAGE_KEY,
  SIDEBAR_MODULE_ORDER_STORAGE_KEY,
  loadHiddenSidebarModules,
  loadSidebarModuleOrder,
  moveSidebarModule,
  normalizeSidebarModuleOrder,
  persistHiddenSidebarModules,
  persistSidebarModuleOrder,
} from './sidebar-modules'

describe('sidebar modules preferences', () => {
  it('ignora valores inválidos e preserva somente ids conhecidos', () => {
    window.localStorage.setItem(SIDEBAR_HIDDEN_MODULES_STORAGE_KEY, JSON.stringify(['history', 'desconhecido', 3]))

    expect(loadHiddenSidebarModules()).toEqual(new Set(['history']))
  })

  it('usa todos os módulos quando a preferência está corrompida', () => {
    window.localStorage.setItem(SIDEBAR_HIDDEN_MODULES_STORAGE_KEY, '{inválido')

    expect(loadHiddenSidebarModules()).toEqual(new Set())
  })

  it('persiste ids em uma ordem estável', () => {
    persistHiddenSidebarModules(new Set(['history', 'components']))

    expect(window.localStorage.getItem(SIDEBAR_HIDDEN_MODULES_STORAGE_KEY)).toBe(JSON.stringify(['components', 'history']))
  })
})

describe('ordem dos módulos da sidebar', () => {
  it('completa a ordem salva com módulos desconhecidos pela preferência', () => {
    expect(normalizeSidebarModuleOrder(['history', 'x', 'history', 'git'])).toEqual([
      'history',
      'git',
      'components',
      'environments',
      'monitors',
      'documents',
      'agent',
    ])
  })

  it('usa a ordem padrão quando a preferência está corrompida', () => {
    window.localStorage.setItem(SIDEBAR_MODULE_ORDER_STORAGE_KEY, '{inválido')

    expect(loadSidebarModuleOrder()).toEqual(['components', 'environments', 'monitors', 'history', 'documents', 'git', 'agent'])
  })

  it('persiste e recarrega a ordem', () => {
    persistSidebarModuleOrder(['git', 'history', 'components', 'environments', 'monitors'])

    expect(loadSidebarModuleOrder()[0]).toBe('git')
  })

  it('move um módulo para antes ou depois do alvo', () => {
    const order = ['components', 'environments', 'monitors', 'history', 'git'] as const

    expect(moveSidebarModule(order, 'history', 'components', 'before').slice(0, 2)).toEqual(['history', 'components'])
    expect(moveSidebarModule(order, 'components', 'monitors', 'after').slice(0, 4)).toEqual([
      'environments',
      'monitors',
      'components',
      'history',
    ])
    expect(moveSidebarModule(order, 'git', 'git', 'after')).toEqual([...order])
  })
})
