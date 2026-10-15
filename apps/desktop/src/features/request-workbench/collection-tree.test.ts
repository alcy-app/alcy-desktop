import { describe, expect, it } from 'vitest'
import {
  allFolderIds,
  applyScopedChanges,
  descendantIds,
  duplicateRequest,
  emptyGrpcCall,
  filterTree,
  findAncestorIds,
  findInheritedAuthentication,
  findNode,
  findRequest,
  findRequestPath,
  folderSubtreeIds,
  insertFolder,
  insertRequest,
  kindOf,
  mergeScopedVariables,
  moveFolder,
  moveItems,
  moveRequest,
  nestedChangeKinds,
  regenerateIds,
  removeNode,
  removeNodes,
  renameNode,
  reorderCollections,
  reorderFolder,
  reorderRequest,
  sortNodeChildren,
  toggleTreeSelection,
  topLevelSelection,
  uniqueChildName,
  uniqueSiblingName,
  updateNodeAuthentication,
  updateRequestContent,
  variableScopesFor,
  variablesAboveNode,
  visibleItemIds,
  withDescendants,
} from './collection-tree'
import type { RequestContent, RequestSummary, TreeNode } from './collection-tree'

const node = (id: string, name: string, folders: TreeNode[] = [], requests: RequestSummary[] = []): TreeNode => ({
  id,
  name,
  folders,
  requests,
  authentication: { type: 'inherit' },
  variables: [],
})

const emptyContent = (): RequestContent => ({
  protocol: 'graphql',
  endpointUrl: '{{baseUrl}}/graphql',
  query: '',
  variables: '{}',
  method: 'post',
  body: { type: 'raw', content: '', rawLanguage: 'json' },
  preRequestScript: '',
  postResponseScript: '',
  headers: [],
  authentication: { type: 'none' },
  routeParams: [],
  grpc: emptyGrpcCall,
})

const request = (id: string, name: string, content: RequestContent = emptyContent()): RequestSummary => ({
  id,
  name,
  protocol: 'graphql',
  content,
})

describe('insertFolder', () => {
  it('insere uma nova coleção no nível raiz quando parentId é null', () => {
    const collections = insertFolder([node('c1', 'Customer API')], null, node('c2', 'Billing API'))

    expect(collections.map((collection) => collection.id)).toEqual(['c1', 'c2'])
  })

  it('insere uma subpasta dentro de uma pasta em qualquer profundidade', () => {
    const collections = [node('c1', 'Customer API', [node('f1', 'Authentication')])]

    const updated = insertFolder(collections, 'f1', node('f2', 'Refresh token'))

    expect(findNode(updated, 'f1')?.folders.map((folder) => folder.id)).toEqual(['f2'])
  })
})

describe('insertRequest', () => {
  it('insere uma requisição dentro de uma coleção ou pasta', () => {
    const collections = [node('c1', 'Customer API', [node('f1', 'Authentication')])]

    const updated = insertRequest(collections, 'f1', request('r1', 'Login'))

    expect(findNode(updated, 'f1')?.requests).toEqual([request('r1', 'Login')])
  })
})

describe('renameNode', () => {
  it('renomeia uma pasta em qualquer profundidade sem afetar os demais', () => {
    const collections = [node('c1', 'Customer API', [node('f1', 'Authentication')])]

    const updated = renameNode(collections, 'f1', 'Auth')

    expect(findNode(updated, 'f1')?.name).toBe('Auth')
    expect(findNode(updated, 'c1')?.name).toBe('Customer API')
  })

  it('renomeia uma requisição em qualquer profundidade', () => {
    const collections = [node('c1', 'Customer API', [node('f1', 'Authentication', [], [request('r1', 'Login')])])]

    const updated = renameNode(collections, 'r1', 'Sign in')

    expect(findNode(updated, 'f1')?.requests[0].name).toBe('Sign in')
  })
})

describe('removeNode', () => {
  it('remove uma pasta e toda a sua subárvore, incluindo requisições', () => {
    const collections = [
      node('c1', 'Customer API', [node('f1', 'Authentication', [], [request('r1', 'Login')])]),
    ]

    const updated = removeNode(collections, 'f1')

    expect(findNode(updated, 'f1')).toBeNull()
    expect(findNode(updated, 'c1')?.folders).toEqual([])
  })

  it('remove uma coleção do nível raiz', () => {
    const collections = [node('c1', 'Customer API'), node('c2', 'Billing API')]

    const updated = removeNode(collections, 'c1')

    expect(updated.map((collection) => collection.id)).toEqual(['c2'])
  })

  it('remove uma requisição sem afetar pastas irmãs', () => {
    const collections = [
      node('c1', 'Customer API', [], [request('r1', 'Login'), request('r2', 'Logout')]),
    ]

    const updated = removeNode(collections, 'r1')

    expect(updated[0].requests).toEqual([request('r2', 'Logout')])
  })
})

describe('uniqueChildName', () => {
  it('mantém o nome quando nenhum irmão o usa ainda', () => {
    const collections = [node('c1', 'Customer API')]

    expect(uniqueChildName(collections, null, 'folder', 'Billing API')).toBe('Billing API')
  })

  it('sufixa incrementando quando já existe um irmão do mesmo tipo com o mesmo nome', () => {
    const collections = [node('c1', 'Nova coleção'), node('c2', 'Nova coleção 2')]

    expect(uniqueChildName(collections, null, 'folder', 'Nova coleção')).toBe('Nova coleção 3')
  })

  it('considera pastas e requisições como namespaces separados no mesmo nível', () => {
    const collections = [node('c1', 'Customer API', [node('f1', 'Orders')], [request('r1', 'Orders')])]

    expect(uniqueChildName(collections, 'c1', 'folder', 'Orders')).toBe('Orders 2')
    expect(uniqueChildName(collections, 'c1', 'request', 'Orders')).toBe('Orders 2')
    expect(uniqueChildName(collections, 'c1', 'request', 'Login')).toBe('Login')
  })
})

describe('uniqueSiblingName', () => {
  it('mantém o nome quando não colide com nenhum irmão do mesmo tipo', () => {
    const collections = [node('c1', 'Customer API', [node('f1', 'Orders'), node('f2', 'Customers')])]

    expect(uniqueSiblingName(collections, 'f1', 'folder', 'Users')).toBe('Users')
  })

  it('sufixa quando colide com um irmão, ignorando o próprio nó', () => {
    const collections = [node('c1', 'Customer API', [node('f1', 'Orders'), node('f2', 'Customers')])]

    expect(uniqueSiblingName(collections, 'f1', 'folder', 'Customers')).toBe('Customers 2')
  })

  it('não colide com o próprio nome atual do nó sendo renomeado', () => {
    const collections = [node('c1', 'Customer API', [node('f1', 'Orders')])]

    expect(uniqueSiblingName(collections, 'f1', 'folder', 'Orders')).toBe('Orders')
  })

  it('sufixa uma requisição renomeada que colide com uma requisição irmã, ignorando pastas', () => {
    const collections = [
      node('c1', 'Customer API', [node('f1', 'Login')], [request('r1', 'Login'), request('r2', 'Logout')]),
    ]

    expect(uniqueSiblingName(collections, 'r2', 'request', 'Login')).toBe('Login 2')
  })
})

describe('updateRequestContent', () => {
  it('substitui o conteúdo de uma requisição sem afetar nome ou id', () => {
    const collections = [node('c1', 'Customer API', [], [request('r1', 'Ping')])]
    const newContent = { ...emptyContent(), query: 'query { ping }' }

    const updated = updateRequestContent(collections, 'r1', newContent)

    expect(updated[0].requests[0]).toEqual({ id: 'r1', name: 'Ping', protocol: 'graphql', content: newContent })
  })

  it('atualiza uma requisição em qualquer profundidade sem afetar pastas irmãs', () => {
    const collections = [node('c1', 'Customer API', [node('f1', 'Authentication', [], [request('r1', 'Login')])])]
    const newContent = { ...emptyContent(), query: 'mutation { login }' }

    const updated = updateRequestContent(collections, 'r1', newContent)

    expect(updated[0].folders[0].requests[0].content).toEqual(newContent)
  })
})

describe('findRequest', () => {
  it('encontra uma requisição em qualquer profundidade', () => {
    const collections = [node('c1', 'Customer API', [node('f1', 'Authentication', [], [request('r1', 'Login')])])]

    expect(findRequest(collections, 'r1')?.name).toBe('Login')
  })

  it('retorna null quando o id não é uma requisição', () => {
    const collections = [node('c1', 'Customer API', [node('f1', 'Authentication')])]

    expect(findRequest(collections, 'f1')).toBeNull()
    expect(findRequest(collections, 'missing')).toBeNull()
  })
})

describe('findRequestPath', () => {
  it('monta o caminho da coleção até uma requisição aninhada', () => {
    const collections = [
      node('c1', 'Customer API', [node('f1', 'Authentication', [], [request('r1', 'Login')])]),
    ]

    expect(findRequestPath(collections, 'r1')).toEqual(['Customer API', 'Authentication', 'Login'])
  })

  it('retorna null quando a requisição não existe', () => {
    expect(findRequestPath([node('c1', 'Customer API')], 'missing')).toBeNull()
  })
})

describe('duplicateRequest', () => {
  it('insere a cópia como próxima irmã do original, preservando conteúdo e protocolo', () => {
    const content = { ...emptyContent(), query: 'query { ping }' }
    const collections = [node('c1', 'Customer API', [], [request('r1', 'Ping', content), request('r2', 'Logout')])]

    const updated = duplicateRequest(collections, 'r1', 'r1-copy', 'Ping cópia')

    expect(updated[0].requests.map((r) => r.id)).toEqual(['r1', 'r1-copy', 'r2'])
    expect(updated[0].requests[1]).toEqual({ id: 'r1-copy', name: 'Ping cópia', protocol: 'graphql', content })
  })

  it('duplica uma requisição em qualquer profundidade sem afetar pastas irmãs', () => {
    const collections = [node('c1', 'Customer API', [node('f1', 'Authentication', [], [request('r1', 'Login')])])]

    const updated = duplicateRequest(collections, 'r1', 'r1-copy', 'Login cópia')

    expect(updated[0].folders[0].requests.map((r) => r.id)).toEqual(['r1', 'r1-copy'])
  })
})

describe('moveRequest', () => {
  it('remove a requisição da origem e insere no destino', () => {
    const collections = [
      node('c1', 'Customer API', [], [request('r1', 'Ping')]),
      node('c2', 'Billing API'),
    ]

    const updated = moveRequest(collections, 'r1', 'c2')

    expect(updated[0].requests).toEqual([])
    expect(updated[1].requests).toEqual([request('r1', 'Ping')])
  })

  it('mantém o nome quando já existe uma requisição com o mesmo nome no destino', () => {
    const collections = [
      node('c1', 'Customer API', [], [request('r1', 'Ping')]),
      node('c2', 'Billing API', [], [request('r2', 'Ping')]),
    ]

    const updated = moveRequest(collections, 'r1', 'c2')

    expect(updated[1].requests.map((r) => r.name)).toEqual(['Ping', 'Ping'])
  })

  it('não altera a árvore quando o id não é uma requisição existente', () => {
    const collections = [node('c1', 'Customer API', [], [request('r1', 'Ping')])]

    expect(moveRequest(collections, 'missing', 'c1')).toBe(collections)
  })
})

describe('reorderRequest', () => {
  it('reordena duas requisições dentro da mesma pasta, posicionando antes do alvo', () => {
    const collections = [
      node('c1', 'Customer API', [], [request('r1', 'Ping'), request('r2', 'Logout'), request('r3', 'Login')]),
    ]

    const updated = reorderRequest(collections, 'r3', 'r1', 'before')

    expect(updated[0].requests.map((r) => r.id)).toEqual(['r3', 'r1', 'r2'])
  })

  it('reordena duas requisições dentro da mesma pasta, posicionando depois do alvo', () => {
    const collections = [
      node('c1', 'Customer API', [], [request('r1', 'Ping'), request('r2', 'Logout'), request('r3', 'Login')]),
    ]

    const updated = reorderRequest(collections, 'r3', 'r1', 'after')

    expect(updated[0].requests.map((r) => r.id)).toEqual(['r1', 'r3', 'r2'])
  })

  it('move e posiciona a requisição junto de um alvo em outra pasta', () => {
    const collections = [
      node('c1', 'Customer API', [], [request('r1', 'Ping')]),
      node('c2', 'Billing API', [], [request('r2', 'Charge'), request('r3', 'Refund')]),
    ]

    const updated = reorderRequest(collections, 'r1', 'r3', 'before')

    expect(updated[0].requests).toEqual([])
    expect(updated[1].requests.map((r) => r.id)).toEqual(['r2', 'r1', 'r3'])
  })

  it('mantém o nome quando colide com um irmão no destino', () => {
    const collections = [
      node('c1', 'Customer API', [], [request('r1', 'Ping')]),
      node('c2', 'Billing API', [], [request('r2', 'Ping')]),
    ]

    const updated = reorderRequest(collections, 'r1', 'r2', 'before')

    expect(updated[1].requests.map((r) => r.name)).toEqual(['Ping', 'Ping'])
  })

  it('não altera a árvore ao arrastar uma requisição sobre si mesma', () => {
    const collections = [node('c1', 'Customer API', [], [request('r1', 'Ping')])]

    expect(reorderRequest(collections, 'r1', 'r1', 'before')).toBe(collections)
  })
})

describe('moveFolder', () => {
  it('move uma pasta para dentro de outra coleção', () => {
    const collections = [
      node('c1', 'Customer API', [node('f1', 'Authentication')]),
      node('c2', 'Billing API'),
    ]

    const updated = moveFolder(collections, 'f1', 'c2')

    expect(updated[0].folders).toEqual([])
    expect(updated[1].folders.map((f) => f.id)).toEqual(['f1'])
  })

  it('deduplica o nome quando colide com uma pasta irmã no destino', () => {
    const collections = [
      node('c1', 'Customer API', [node('f1', 'Auth')]),
      node('c2', 'Billing API', [node('f2', 'Auth')]),
    ]

    const updated = moveFolder(collections, 'f1', 'c2')

    expect(updated[1].folders.map((f) => f.name)).toEqual(['Auth', 'Auth 2'])
  })

  it('rejeita mover uma pasta para dentro de si mesma', () => {
    const collections = [node('c1', 'Customer API', [node('f1', 'Auth')])]

    expect(moveFolder(collections, 'f1', 'f1')).toBe(collections)
  })

  it('rejeita mover uma pasta para dentro de uma de suas próprias subpastas', () => {
    const collections = [node('c1', 'Customer API', [node('f1', 'Auth', [node('f2', 'Refresh token')])])]

    expect(moveFolder(collections, 'f1', 'f2')).toBe(collections)
  })
})

describe('reorderFolder', () => {
  it('reordena duas pastas irmãs, posicionando antes do alvo', () => {
    const collections = [
      node('c1', 'Customer API', [node('f1', 'Auth'), node('f2', 'Billing'), node('f3', 'Reports')]),
    ]

    const updated = reorderFolder(collections, 'f3', 'f1', 'before')

    expect(updated[0].folders.map((f) => f.id)).toEqual(['f3', 'f1', 'f2'])
  })

  it('reordena duas pastas irmãs, posicionando depois do alvo', () => {
    const collections = [
      node('c1', 'Customer API', [node('f1', 'Auth'), node('f2', 'Billing'), node('f3', 'Reports')]),
    ]

    const updated = reorderFolder(collections, 'f3', 'f1', 'after')

    expect(updated[0].folders.map((f) => f.id)).toEqual(['f1', 'f3', 'f2'])
  })

  it('move e posiciona a pasta junto de uma pasta alvo em outra coleção', () => {
    const collections = [
      node('c1', 'Customer API', [node('f1', 'Auth')]),
      node('c2', 'Billing API', [node('f2', 'Charges'), node('f3', 'Refunds')]),
    ]

    const updated = reorderFolder(collections, 'f1', 'f3', 'before')

    expect(updated[0].folders).toEqual([])
    expect(updated[1].folders.map((f) => f.id)).toEqual(['f2', 'f1', 'f3'])
  })

  it('deduplica o nome quando colide com uma pasta irmã no destino', () => {
    const collections = [
      node('c1', 'Customer API', [node('f1', 'Auth')]),
      node('c2', 'Billing API', [node('f2', 'Auth')]),
    ]

    const updated = reorderFolder(collections, 'f1', 'f2', 'before')

    expect(updated[1].folders.map((f) => f.name)).toEqual(['Auth 2', 'Auth'])
  })

  it('não altera a árvore ao arrastar uma pasta sobre si mesma', () => {
    const collections = [node('c1', 'Customer API', [node('f1', 'Auth')])]

    expect(reorderFolder(collections, 'f1', 'f1', 'before')).toBe(collections)
  })

  it('não altera a árvore ao arrastar uma pasta sobre uma de suas próprias subpastas', () => {
    const collections = [node('c1', 'Customer API', [node('f1', 'Auth', [node('f2', 'Refresh token')])])]

    expect(reorderFolder(collections, 'f1', 'f2', 'before')).toBe(collections)
  })
})

describe('reorderCollections', () => {
  it('reordena as coleções no nível raiz, posicionando antes do alvo', () => {
    const collections = [node('c1', 'Customer API'), node('c2', 'Billing API'), node('c3', 'Reporting API')]

    const updated = reorderCollections(collections, 'c3', 'c1', 'before')

    expect(updated.map((c) => c.id)).toEqual(['c3', 'c1', 'c2'])
  })

  it('reordena as coleções no nível raiz, posicionando depois do alvo', () => {
    const collections = [node('c1', 'Customer API'), node('c2', 'Billing API'), node('c3', 'Reporting API')]

    const updated = reorderCollections(collections, 'c3', 'c1', 'after')

    expect(updated.map((c) => c.id)).toEqual(['c1', 'c3', 'c2'])
  })

  it('não altera a árvore ao arrastar uma coleção sobre si mesma', () => {
    const collections = [node('c1', 'Customer API'), node('c2', 'Billing API')]

    expect(reorderCollections(collections, 'c1', 'c1', 'before')).toBe(collections)
  })
})

describe('sortNodeChildren', () => {
  it('ordena as pastas e requisições diretas em ordem crescente, sem misturar os grupos', () => {
    const collections = [
      node('c1', 'Customer API', [node('f1', 'zebra'), node('f2', 'Árvore'), node('f3', 'Item 10'), node('f4', 'item 2')], [
        request('r1', 'zebra'),
        request('r2', 'Árvore'),
        request('r3', 'Item 10'),
        request('r4', 'item 2'),
      ]),
    ]

    const updated = sortNodeChildren(collections, 'c1', 'ascending')

    expect(updated[0].folders.map((folder) => folder.name)).toEqual(['Árvore', 'item 2', 'Item 10', 'zebra'])
    expect(updated[0].requests.map((savedRequest) => savedRequest.name)).toEqual(['Árvore', 'item 2', 'Item 10', 'zebra'])
  })

  it('ordena somente os filhos diretos em ordem decrescente', () => {
    const collections = [
      node('c1', 'Customer API', [node('f1', 'Beta', [node('f2', 'a')]), node('f3', 'Alpha')]),
    ]

    const updated = sortNodeChildren(collections, 'c1', 'descending')

    expect(updated[0].folders.map((folder) => folder.name)).toEqual(['Beta', 'Alpha'])
    expect(updated[0].folders[0].folders.map((folder) => folder.name)).toEqual(['a'])
  })

  it('preserva a referência quando o conteúdo já está na ordem escolhida', () => {
    const collections = [node('c1', 'Customer API', [node('f1', 'Alpha'), node('f2', 'Beta')])]

    expect(sortNodeChildren(collections, 'c1', 'ascending')).toBe(collections)
  })
})

describe('kindOf', () => {
  it('identifica uma pasta ou coleção pelo id', () => {
    const collections = [node('c1', 'Customer API', [node('f1', 'Authentication')])]

    expect(kindOf(collections, 'c1')).toBe('folder')
    expect(kindOf(collections, 'f1')).toBe('folder')
  })

  it('identifica uma requisição pelo id', () => {
    const collections = [node('c1', 'Customer API', [], [request('r1', 'Login')])]

    expect(kindOf(collections, 'r1')).toBe('request')
  })
})

describe('regenerateIds', () => {
  it('atribui um novo id a uma coleção, suas subpastas e requisições, preservando nome e conteúdo', () => {
    const content = emptyContent()
    const tree = node('c1', 'Customer API', [node('f1', 'Authentication', [], [request('r1', 'Login', content)])])

    let counter = 0
    const updated = regenerateIds(tree, () => `new-${++counter}`)

    expect(updated.id).not.toBe('c1')
    expect(updated.folders[0].id).not.toBe('f1')
    expect(updated.folders[0].requests[0].id).not.toBe('r1')

    expect(updated.name).toBe('Customer API')
    expect(updated.folders[0].name).toBe('Authentication')
    expect(updated.folders[0].requests[0].name).toBe('Login')
    expect(updated.folders[0].requests[0].content).toEqual(content)
  })

  it('gera ids distintos para cada nó', () => {
    const tree = node('c1', 'Customer API', [node('f1', 'A'), node('f2', 'B')], [request('r1', 'Ping')])

    const updated = regenerateIds(tree)
    const ids = [updated.id, ...updated.folders.map((f) => f.id), ...updated.requests.map((r) => r.id)]

    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('filterTree', () => {
  it('devolve a árvore original quando a busca está vazia ou só tem espaços', () => {
    const collections = [node('c1', 'Customer API', [], [request('r1', 'Login')])]

    expect(filterTree(collections, '')).toBe(collections)
    expect(filterTree(collections, '   ')).toBe(collections)
  })

  it('mantém só as requisições cujo nome ou URL casam com a busca, sem diferenciar maiúsculas/minúsculas', () => {
    const login = request('r1', 'Login', { ...emptyContent(), endpointUrl: '{{baseUrl}}/auth/login' })
    const users = request('r2', 'List users', { ...emptyContent(), endpointUrl: '{{baseUrl}}/users' })
    const collections = [node('c1', 'Customer API', [], [login, users])]

    expect(filterTree(collections, 'LOGIN')[0].requests.map((r) => r.id)).toEqual(['r1'])
    expect(filterTree(collections, 'users')[0].requests.map((r) => r.id)).toEqual(['r2'])
  })

  it('remove pastas e coleções sem nenhum descendente correspondente', () => {
    const collections = [
      node('c1', 'Customer API', [node('f1', 'Auth', [], [request('r1', 'Login')])]),
      node('c2', 'Billing API', [], [request('r2', 'Charge card')]),
    ]

    expect(filterTree(collections, 'login').map((c) => c.id)).toEqual(['c1'])
  })

  it('mantém a subárvore inteira quando o próprio nome de uma pasta/coleção casa com a busca', () => {
    const collections = [
      node('c1', 'Auth API', [node('f1', 'Tokens', [], [request('r1', 'Refresh')])], [request('r2', 'Ping')]),
    ]

    const filtered = filterTree(collections, 'auth')

    expect(filtered).toEqual(collections)
  })
})

describe('findAncestorIds', () => {
  it('lista a coleção e as pastas que contêm a requisição', () => {
    const collections = [
      node('c1', 'Customer API', [node('f1', 'Authentication', [], [request('r1', 'Login')])]),
    ]

    expect(findAncestorIds(collections, 'r1')).toEqual(['c1', 'f1'])
  })

  it('retorna null quando a requisição não está na árvore', () => {
    expect(findAncestorIds([node('c1', 'Customer API')], 'missing')).toBeNull()
  })
})

describe('findInheritedAuthentication', () => {
  const tree = (): TreeNode[] => [
    {
      ...node('c1', 'Customer API', [node('f1', 'Orders', [], [request('r1', 'List')])]),
      authentication: { type: 'bearer', token: 'collection' },
    },
  ]

  it('usa a autenticação da coleção quando as pastas intermediárias herdam', () => {
    expect(findInheritedAuthentication(tree(), 'r1')).toEqual({
      name: 'Customer API',
      authentication: { type: 'bearer', token: 'collection' },
    })
  })

  it('prefere a pasta ancestral mais próxima que define autenticação', () => {
    const updated = updateNodeAuthentication(tree(), 'f1', { type: 'customHeader', name: 'X-Key', value: 'k' })

    expect(findInheritedAuthentication(updated, 'r1')).toEqual({
      name: 'Orders',
      authentication: { type: 'customHeader', name: 'X-Key', value: 'k' },
    })
  })

  it('resulta em nenhuma autenticação quando ninguém define ou a requisição não existe', () => {
    const updated = updateNodeAuthentication(tree(), 'c1', { type: 'inherit' })

    expect(findInheritedAuthentication(updated, 'r1')).toEqual({ name: null, authentication: { type: 'none' } })
    expect(findInheritedAuthentication(updated, 'missing')).toEqual({ name: null, authentication: { type: 'none' } })
  })
})

describe('nestedChangeKinds', () => {
  it('propaga a marca de uma requisição alterada até a pasta e a coleção ancestrais', () => {
    const collections = [node('c1', 'Customer API', [node('f1', 'Orders', [], [request('r1', 'List orders')])])]
    const changeMarkers = new Map([['r1', 'modified' as const]])

    const nested = nestedChangeKinds(collections, changeMarkers)

    expect(nested.get('f1')).toBe('modified')
    expect(nested.get('c1')).toBe('modified')
    // A própria requisição tem marca própria — não entra no mapa de "aninhado".
    expect(nested.has('r1')).toBe(false)
  })

  it('quando a pasta em si também mudou, ela não entra no mapa de aninhado (a marca própria já cobre)', () => {
    const collections = [node('c1', 'Customer API', [node('f1', 'Orders', [], [request('r1', 'List orders')])])]
    const changeMarkers = new Map([
      ['f1', 'added' as const],
      ['r1', 'modified' as const],
    ])

    const nested = nestedChangeKinds(collections, changeMarkers)

    // f1 tem marca própria (added) — não aparece como "aninhado".
    expect(nested.has('f1')).toBe(false)
    // c1 não tem marca própria, mas contém f1 (added) e r1 (modified) — usa a mais forte.
    expect(nested.get('c1')).toBe('added')
  })

  it('prioriza deleted > modified > added ao agregar várias marcas', () => {
    const collections = [
      node('c1', 'Customer API', [], [request('r1', 'List orders'), request('r2', 'Create order'), request('r3', 'Cancel order')]),
    ]
    const changeMarkers = new Map([
      ['r1', 'added' as const],
      ['r2', 'modified' as const],
      ['r3', 'deleted' as const],
    ])

    expect(nestedChangeKinds(collections, changeMarkers).get('c1')).toBe('deleted')
  })

  it('não marca nada quando não há alteração nenhuma na árvore', () => {
    const collections = [node('c1', 'Customer API', [node('f1', 'Orders', [], [request('r1', 'List orders')])])]

    expect(nestedChangeKinds(collections, new Map()).size).toBe(0)
  })
})

describe('variáveis de coleção e pasta', () => {
  const withVariables = (tree: TreeNode, variables: Record<string, string>): TreeNode => ({
    ...tree,
    variables: Object.entries(variables).map(([name, value]) => ({ name, value })),
  })
  // Coleção c (baseUrl, only) > pasta f1 (baseUrl) > subpasta f2 (token) > requisição deep; root direto na coleção.
  const tree = [
    withVariables(
      node(
        'c',
        'API',
        [withVariables(node('f1', 'Pedidos', [withVariables(node('f2', 'Detalhe', [], [request('deep', 'Deep')]), { token: 'f2' })]), { baseUrl: 'f1' })],
        [request('root', 'Root')],
      ),
      { baseUrl: 'c', only: 'c' },
    ),
  ]
  const environment = [
    { name: 'baseUrl', value: 'env', sensitive: false },
    { name: 'token', value: 'env', sensitive: true },
    { name: 'envOnly', value: 'env', sensitive: false },
  ]
  const valueOf = (variables: { name: string; value: string }[], name: string) =>
    variables.find((variable) => variable.name === name)?.value

  it('monta as camadas da coleção até a pasta pai direta', () => {
    expect(variableScopesFor(tree, 'deep').map(({ nodeId, kind }) => [nodeId, kind])).toEqual([
      ['c', 'collection'],
      ['f1', 'folder'],
      ['f2', 'folder'],
    ])
    expect(variableScopesFor(tree, 'root').map(({ nodeId }) => nodeId)).toEqual(['c'])
    expect(variableScopesFor(tree, null)).toEqual([])
    expect(variableScopesFor(tree, 'missing')).toEqual([])
  })

  it('não envia nas camadas as variáveis ainda sem nome', () => {
    const withDraft = [{ ...tree[0], variables: [...tree[0].variables, { name: '  ', value: 'rascunho' }] }]

    expect(variableScopesFor(withDraft, 'root')[0].variables.map(({ name }) => name)).toEqual(['baseUrl', 'only'])
  })

  it('o escopo mais próximo vence e informa a origem', () => {
    const merged = mergeScopedVariables(environment, tree, 'deep')

    expect(valueOf(merged, 'baseUrl')).toBe('f1')
    expect(valueOf(merged, 'only')).toBe('c')
    expect(valueOf(merged, 'envOnly')).toBe('env')
    const token = merged.find((variable) => variable.name === 'token')
    expect(token).toEqual({ name: 'token', value: 'f2', sensitive: false, source: { nodeId: 'f2', kind: 'folder', name: 'Detalhe' } })
    expect(merged.find((variable) => variable.name === 'envOnly')?.source).toBeUndefined()
  })

  it('aba não salva usa só o ambiente', () => {
    expect(mergeScopedVariables(environment, tree, null)).toBe(environment)
  })

  it('para uma pasta, considera só os ancestores', () => {
    const above = variablesAboveNode(environment, tree, 'f1')

    expect(valueOf(above, 'baseUrl')).toBe('c')
    expect(valueOf(above, 'token')).toBe('env')
  })

  it('aplica gravações de script criando ou substituindo a variável', () => {
    const next = applyScopedChanges(tree, [
      { nodeId: 'f2', name: 'token', value: 'novo' },
      { nodeId: 'c', name: 'created', value: '1' },
      { nodeId: 'missing', name: 'x', value: 'y' },
    ])

    expect(findNode(next, 'f2')?.variables).toEqual([{ name: 'token', value: 'novo' }])
    expect(findNode(next, 'c')?.variables).toEqual([
      { name: 'baseUrl', value: 'c' },
      { name: 'only', value: 'c' },
      { name: 'created', value: '1' },
    ])
  })
})

describe('seleção múltipla', () => {
  const tree = () => [
    node('c1', 'Customer API', [node('f1', 'Orders', [node('f2', 'Old')], [request('r1', 'List orders')])], [
      request('r2', 'Get user'),
    ]),
    node('c2', 'Billing', [], [request('r3', 'Invoice')]),
  ]

  it('topLevelSelection ignora descendentes de itens selecionados e ids inexistentes, na ordem da árvore', () => {
    expect(topLevelSelection(tree(), new Set(['r3', 'r1', 'f1', 'gone', 'r2']))).toEqual(['f1', 'r2', 'r3'])
  })

  it('visibleItemIds só desce nas pastas expandidas, pastas antes de requisições', () => {
    expect(visibleItemIds(tree(), new Set(['c1', 'c2']))).toEqual(['c1', 'f1', 'r2', 'c2', 'r3'])
    expect(visibleItemIds(tree(), new Set(['c1', 'f1']))).toEqual(['c1', 'f1', 'f2', 'r1', 'r2', 'c2'])
  })

  it('descendantIds lista subpastas e requisições em qualquer nível, sem o próprio item', () => {
    expect(descendantIds(tree(), 'c1')).toEqual(['f1', 'f2', 'r1', 'r2'])
    expect(descendantIds(tree(), 'r1')).toEqual([])
    expect(withDescendants(tree(), ['f1', 'r3'])).toEqual(['f1', 'f2', 'r1', 'r3'])
  })

  it('toggleTreeSelection marca o conteúdo junto e, ao desmarcar, solta também os ancestrais', () => {
    const selected = toggleTreeSelection(tree(), new Set(), 'c1')
    expect(selected).toEqual(new Set(['c1', 'f1', 'f2', 'r1', 'r2']))

    const withoutChild = toggleTreeSelection(tree(), selected, 'r1')
    expect(withoutChild).toEqual(new Set(['f2', 'r2']))
    expect(topLevelSelection(tree(), withoutChild)).toEqual(['f2', 'r2'])

    expect(toggleTreeSelection(tree(), selected, 'c1')).toEqual(new Set())
  })

  it('allFolderIds inclui collections e todas as subpastas, sem requisições', () => {
    expect(allFolderIds(tree())).toEqual(new Set(['c1', 'f1', 'f2', 'c2']))
  })

  it('folderSubtreeIds junta as pastas selecionadas e suas subpastas, ignorando requisições', () => {
    expect(folderSubtreeIds(tree(), ['f1', 'r3'])).toEqual(new Set(['f1', 'f2']))
  })

  it('removeNodes remove todos os itens de uma vez', () => {
    const updated = removeNodes(tree(), ['f1', 'r3'])

    expect(findNode(updated, 'f1')).toBeNull()
    expect(findRequest(updated, 'r1')).toBeNull()
    expect(findRequest(updated, 'r3')).toBeNull()
    expect(findRequest(updated, 'r2')).not.toBeNull()
  })

  it('moveItems move pastas e requisições para o destino, deduplicando só nomes de pastas', () => {
    const collections = [...tree(), node('c3', 'Target', [node('x', 'Orders')], [request('y', 'Get user')])]

    const updated = moveItems(collections, ['r1', 'f1', 'r2'], 'c3')
    const target = findNode(updated, 'c3')

    // `r1` vai junto com a pasta `f1`, não sozinho.
    expect(target?.folders.map((folder) => [folder.id, folder.name])).toEqual([
      ['x', 'Orders'],
      ['f1', 'Orders 2'],
    ])
    expect(target?.requests.map((item) => [item.id, item.name])).toEqual([
      ['y', 'Get user'],
      ['r2', 'Get user'],
    ])
    expect(findNode(updated, 'f1')?.requests.map((item) => item.id)).toEqual(['r1'])
  })

  it('moveItems ignora coleções, o próprio destino e mover uma pasta para dentro de si', () => {
    const updated = moveItems(tree(), ['c2', 'f1', 'r2'], 'f2')

    expect(updated.map((collection) => collection.id)).toEqual(['c1', 'c2'])
    expect(findNode(updated, 'f2')?.folders).toEqual([])
    expect(findNode(updated, 'f2')?.requests.map((item) => item.id)).toEqual(['r2'])
  })
})
