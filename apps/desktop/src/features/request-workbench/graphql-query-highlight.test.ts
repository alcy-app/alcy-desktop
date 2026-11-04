import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { translate } from '../../shared/i18n/translations'
import { graphqlQueryHighlight, setQueryVariables } from './graphql-query-highlight'

const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate('pt-BR', key, params)

describe('graphqlQueryHighlight', () => {
  it('gives {{variable}} inside a string the same chip and states as the other editors', () => {
    // `{{token}}` spans 15..24, inside the string `"{{token}}"`.
    const view = new EditorView({ doc: 'query { a(id: "{{token}}") }', extensions: [graphqlQueryHighlight(() => t)] })
    view.dispatch({ effects: setQueryVariables.of([{ name: 'token', value: 'abc', sensitive: false }]) })

    const token = () => view.dom.querySelector('.var-token--known') as HTMLElement
    expect(token()).toHaveTextContent('{{token}}')
    expect(token().closest('.gql-token--string')).toBeNull()
    expect([...token().querySelectorAll('.var-token-brace')].map((brace) => brace.textContent)).toEqual(['{{', '}}'])

    view.dispatch({ selection: { anchor: 18 } })
    expect(token()).toHaveClass('var-token--active')

    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } })
    expect(token()).toHaveClass('var-token--selected')
    view.destroy()
  })
})
