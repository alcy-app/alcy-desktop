import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach } from 'vitest'
import { cleanup } from '@testing-library/react'

afterEach(cleanup)
afterEach(() => window.localStorage.clear())
// Os testes partem de um app já aberto nesta versão: a aba "Novidades da
// versão" só abre sozinha nos testes que limparem esta chave.
beforeEach(() => window.localStorage.setItem('alcy:release-notes:seen-version', __APP_VERSION__))

/**
 * jsdom não implementa `Range.getClientRects`/`getBoundingClientRect` (só
 * `Element` tem essas), mas o CodeMirror 6 (editores de query, corpo da
 * requisição e resposta) chama ambos ao medir texto — sem isso, qualquer
 * dispatch que dispare uma medição (ex.: `requestAnimationFrame` após uma
 * mudança de documento) derruba o teste com "is not a function". Retornos
 * zerados bastam: o CodeMirror já tolera medições vazias graciosamente, já
 * que é o mesmo resultado que teria num layout ainda não pintado.
 */
const emptyDomRect: DOMRect = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  width: 0,
  height: 0,
  toJSON: () => {},
}

if (typeof Range.prototype.getClientRects !== 'function') {
  Range.prototype.getClientRects = () => ({
    length: 0,
    item: () => null,
    [Symbol.iterator]: function* () {},
  }) as unknown as DOMRectList
}

if (typeof Range.prototype.getBoundingClientRect !== 'function') {
  Range.prototype.getBoundingClientRect = () => emptyDomRect
}

/**
 * jsdom não implementa `ResizeObserver` — o canvas de flows (`@xyflow/react`,
 * ver ADR 0013) usa internamente para medir o viewport/os containers de
 * node. Sem isso, montar `FlowCanvas`/`<ReactFlow>` em teste derruba com
 * "ResizeObserver is not defined". Um no-op basta: os testes não dependem
 * de medição de layout real.
 */
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}
