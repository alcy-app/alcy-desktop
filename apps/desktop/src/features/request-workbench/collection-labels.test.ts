import { describe, expect, it } from 'vitest'
import type { CollectionLabelDto } from '../../bindings/list-collections'
import {
  filterCollections,
  labelCatalog,
  recolorLabelEverywhere,
  removeLabelEverywhere,
  renameLabelEverywhere,
  sortFavoritesFirst,
  assignCollectionLabel,
} from './collection-labels'
import type { TreeNode } from './collection-tree'

const collection = (id: string, labels?: CollectionLabelDto[]): TreeNode => ({
  id,
  name: id,
  folders: [],
  requests: [],
  authentication: { type: 'inherit' },
  variables: [],
  ...(labels ? { labels } : {}),
})

const ids = (nodes: TreeNode[]) => nodes.map((node) => node.id)

describe('labelCatalog', () => {
  it('une os rótulos sem repetir nomes, com a cor da primeira ocorrência e em ordem alfabética', () => {
    const catalog = labelCatalog([
      collection('a', [{ name: 'Pagamentos', color: 'green' }]),
      collection('b', [
        { name: 'pagamentos', color: 'red' },
        { name: 'Legado', color: 'gray' },
      ]),
      collection('c'),
    ])

    expect(catalog).toEqual([
      { name: 'Legado', color: 'gray' },
      { name: 'Pagamentos', color: 'green' },
    ])
  })
})

describe('assignCollectionLabel', () => {
  it('adiciona o rótulo e remove o campo quando o último sai', () => {
    const added = assignCollectionLabel([collection('a')], ['a'], { name: ' Interno ', color: 'blue' }, true)
    expect(added[0].labels).toEqual([{ name: 'Interno', color: 'blue' }])

    const removed = assignCollectionLabel(added, ['a'], { name: 'interno', color: 'blue' }, false)
    expect(removed[0]).not.toHaveProperty('labels')
  })

  it('aplica a várias collections sem duplicar onde o rótulo já existe', () => {
    const nodes = [collection('a', [{ name: 'Interno', color: 'blue' }]), collection('b'), collection('c')]
    const result = assignCollectionLabel(nodes, ['a', 'b'], { name: 'interno', color: 'blue' }, true)

    expect(result[0]).toBe(nodes[0])
    expect(result[1].labels).toEqual([{ name: 'interno', color: 'blue' }])
    expect(result[2]).toBe(nodes[2])
  })
})

describe('renameLabelEverywhere', () => {
  it('renomeia em todas as collections que usam o rótulo', () => {
    const result = renameLabelEverywhere(
      [collection('a', [{ name: 'Legado', color: 'gray' }]), collection('b', [{ name: 'legado', color: 'gray' }]), collection('c')],
      'Legado',
      'Antigo',
    )

    expect(result.map((node) => node.labels)).toEqual([
      [{ name: 'Antigo', color: 'gray' }],
      [{ name: 'Antigo', color: 'gray' }],
      undefined,
    ])
  })

  it('mescla com um rótulo existente, mantendo a cor do destino e a posição', () => {
    const result = renameLabelEverywhere(
      [
        collection('a', [
          { name: 'Interno', color: 'blue' },
          { name: 'Legado', color: 'gray' },
        ]),
        collection('b', [
          { name: 'Legado', color: 'gray' },
          { name: 'Interno', color: 'blue' },
        ]),
      ],
      'Legado',
      'interno',
    )

    expect(result[0].labels).toEqual([{ name: 'interno', color: 'blue' }])
    expect(result[1].labels).toEqual([{ name: 'interno', color: 'blue' }])
  })

  it('ignora nome vazio', () => {
    const nodes = [collection('a', [{ name: 'Legado', color: 'gray' }])]
    expect(renameLabelEverywhere(nodes, 'Legado', '  ')).toBe(nodes)
  })
})

describe('recolorLabelEverywhere e removeLabelEverywhere', () => {
  const nodes = [
    collection('a', [{ name: 'Legado', color: 'gray' }, { name: 'Interno', color: 'blue' }]),
    collection('b', [{ name: 'legado', color: 'gray' }]),
  ]

  it('troca a cor em todas as collections', () => {
    const result = recolorLabelEverywhere(nodes, 'Legado', 'orange')
    expect(result[0].labels?.[0].color).toBe('orange')
    expect(result[0].labels?.[1].color).toBe('blue')
    expect(result[1].labels?.[0].color).toBe('orange')
  })

  it('remove de todas as collections', () => {
    const result = removeLabelEverywhere(nodes, 'LEGADO')
    expect(result[0].labels).toEqual([{ name: 'Interno', color: 'blue' }])
    expect(result[1]).not.toHaveProperty('labels')
  })
})

describe('filterCollections', () => {
  const nodes = [
    collection('a', [{ name: 'Pagamentos', color: 'green' }]),
    collection('b', [{ name: 'Legado', color: 'gray' }]),
    collection('c'),
  ]

  it('sem filtros devolve a lista original', () => {
    expect(filterCollections(nodes, { favoritesOnly: false, labelKeys: new Set() }, new Set())).toBe(nodes)
  })

  it('combina rótulos por "ou"', () => {
    const result = filterCollections(nodes, { favoritesOnly: false, labelKeys: new Set(['pagamentos', 'legado']) }, new Set())
    expect(ids(result)).toEqual(['a', 'b'])
  })

  it('combina favoritas e rótulos por "e"', () => {
    const favorites = new Set(['b', 'c'])
    expect(ids(filterCollections(nodes, { favoritesOnly: true, labelKeys: new Set() }, favorites))).toEqual(['b', 'c'])
    expect(ids(filterCollections(nodes, { favoritesOnly: true, labelKeys: new Set(['legado', 'pagamentos']) }, favorites))).toEqual(['b'])
  })
})

describe('sortFavoritesFirst', () => {
  it('coloca as favoritas no topo preservando a ordem manual de cada grupo', () => {
    const nodes = [collection('a'), collection('b'), collection('c'), collection('d')]
    expect(ids(sortFavoritesFirst(nodes, new Set(['d', 'b'])))).toEqual(['b', 'd', 'a', 'c'])
  })

  it('sem favoritas devolve a lista original', () => {
    const nodes = [collection('a')]
    expect(sortFavoritesFirst(nodes, new Set(['x']))).toBe(nodes)
  })
})
