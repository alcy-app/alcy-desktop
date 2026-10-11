import type { Snapshot } from './types'

/**
 * Snapshot de exemplo para desenvolver o runtime com
 * `vite --config vite.webclient.config.ts`. Só entra no modo dev; o build
 * descarta o import.
 */
export const DEV_SAMPLE: Snapshot = {
  version: 1,
  exportId: 'dev-sample',
  title: 'Exemplo',
  transport: 'auto',
  environment: {
    name: 'Dev',
    variables: [
      { name: 'baseUrl', value: 'https://httpbin.org' },
      { name: 'token', value: '' },
    ],
  },
  credentials: [{ id: 'variable:token', owner: null, target: { kind: 'variable', name: 'token' }, included: false }],
  root: {
    id: 'root',
    name: 'httpbin',
    variables: [],
    authentication: { type: 'bearer', token: '{{token}}' },
    folders: [
      {
        id: 'folder',
        name: 'Dados',
        variables: [],
        authentication: { type: 'inherit' },
        folders: [],
        requests: [
          {
            id: 'post',
            name: 'Enviar JSON',
            protocol: 'rest',
            method: 'POST',
            url: '{{baseUrl}}/anything/:id',
            headers: [{ name: 'Content-Type', value: 'application/json', enabled: true }],
            authentication: { type: 'inherit' },
            body: '{\n  "hello": "world"\n}',
            bodyPayload: { type: 'raw', language: 'json' },
            variables: '',
            routeParameters: [{ name: 'id', value: '42' }],
            unsupported: [],
          },
        ],
      },
    ],
    requests: [
      {
        id: 'get',
        name: 'Consultar',
        protocol: 'rest',
        method: 'GET',
        url: '{{baseUrl}}/get?page=1',
        headers: [],
        authentication: { type: 'none' },
        body: '',
        bodyPayload: { type: 'none' },
        variables: '',
        routeParameters: [],
        unsupported: [],
      },
    ],
  },
}
