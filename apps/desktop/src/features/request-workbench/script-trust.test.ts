import { describe, expect, it } from 'vitest'
import type { RequestSummary, TreeNode } from './collection-tree'
import { collectionOfRequest, collectionScriptsLock, nodeHasScripts, npmPackages, scriptedRequests } from './script-trust'

function request(id: string, pre = '', post = ''): RequestSummary {
  return { id, name: id, protocol: 'rest', content: { preRequestScript: pre, postResponseScript: post } } as unknown as RequestSummary
}

function node(id: string, requests: RequestSummary[], folders: TreeNode[] = [], untrustedScripts = false): TreeNode {
  return {
    id,
    name: id,
    folders,
    requests,
    authentication: { type: 'inherit' },
    variables: [],
    ...(untrustedScripts ? { untrustedScripts } : {}),
  } as TreeNode
}

const nested = node('collection', [request('plain', '  ')], [node('folder', [request('scripted', '', 'al.test()')])], true)

describe('script trust', () => {
  it('finds scripts at any depth and ignores whitespace', () => {
    expect(nodeHasScripts(nested)).toBe(true)
    expect(nodeHasScripts(node('empty', [request('a', ' ', '\n')]))).toBe(false)
    expect(scriptedRequests(nested).map(({ path, request }) => [path, request.id])).toEqual([[['folder'], 'scripted']])
  })

  it('finds the collection of a request', () => {
    expect(collectionOfRequest([nested], 'scripted')?.id).toBe('collection')
    expect(collectionOfRequest([nested], null)).toBeNull()
    expect(collectionOfRequest([nested], 'missing')).toBeNull()
  })

  it('locks scripts like the backend', () => {
    const trusted = node('trusted', [request('a', 'x')])
    expect(collectionScriptsLock('trusted', trusted)).toBeNull()
    expect(collectionScriptsLock('trusted', nested)).toBe('collection')
    expect(collectionScriptsLock('undecided', trusted)).toBe('workspace')
    expect(collectionScriptsLock(null, trusted)).toBe('workspace')
    expect(collectionScriptsLock('untrusted', null)).toBeNull()
  })

  it('lists the npm packages scripts require literally, like the backend', () => {
    const pre = [
      "const dayjs = require('npm:dayjs@1.11.13');",
      'const again = al.require( "npm:dayjs@1.11.13" );',
      'const scoped = pm.require(`npm:@scope/pkg@2.0.0`);',
      "const local = require('lodash');",
      "const dynamic = require('npm:' + name);",
      'const template = require(`npm:${name}`);',
    ].join('\n')
    expect(npmPackages([pre, "require('npm:left-pad@1.3.0')", "require('npm:dayjs@1.11.13')"])).toEqual([
      'dayjs@1.11.13',
      '@scope/pkg@2.0.0',
      'left-pad@1.3.0',
    ])
    expect(npmPackages(['al.test()', ''])).toEqual([])
  })
})
