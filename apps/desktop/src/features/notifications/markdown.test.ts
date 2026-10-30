import { describe, expect, it } from 'vitest'
import { parseInline, parseMarkdown } from './markdown'

const text = (value: string) => ({ type: 'text', text: value })

describe('parseMarkdown', () => {
  it('recognizes ATX and setext headings', () => {
    expect(parseMarkdown('# Novidades #\n\nResumo\n---\n\n###### Fim')).toEqual([
      { type: 'heading', level: 1, children: [text('Novidades')] },
      { type: 'heading', level: 2, children: [text('Resumo')] },
      { type: 'heading', level: 6, children: [text('Fim')] },
    ])
  })

  it('does not treat #hashtag as a heading', () => {
    expect(parseMarkdown('#123 corrigido')).toEqual([{ type: 'paragraph', children: [text('#123 corrigido')] }])
  })

  it('joins paragraph lines and honors hard breaks', () => {
    expect(parseMarkdown('linha 1\nlinha 2  \nlinha 3\\\nlinha 4\n\noutro')).toEqual([
      {
        type: 'paragraph',
        children: [text('linha 1 linha 2'), { type: 'break' }, text('linha 3'), { type: 'break' }, text('linha 4')],
      },
      { type: 'paragraph', children: [text('outro')] },
    ])
  })

  it('keeps fenced code blocks and their language', () => {
    expect(parseMarkdown('```bash\npnpm check\n  # *sem* markdown\n```\ndepois')).toEqual([
      { type: 'code', text: 'pnpm check\n  # *sem* markdown', lang: 'bash' },
      { type: 'paragraph', children: [text('depois')] },
    ])
  })

  it('parses GFM tables with alignment, inline content and escaped pipes', () => {
    expect(parseMarkdown('| Campo | Tipo | Total |\n|:---|:---:|---:|\n| `id` | **int** | 1 |\n| a \\| b | | 2 | extra\n| só um\n\ndepois')).toEqual([
      {
        type: 'table',
        align: ['left', 'center', 'right'],
        header: [[text('Campo')], [text('Tipo')], [text('Total')]],
        rows: [
          [[{ type: 'code', text: 'id' }], [{ type: 'strong', children: [text('int')] }], [text('1')]],
          [[text('a | b')], [], [text('2')]],
          [[text('só um')], [], []],
        ],
      },
      { type: 'paragraph', children: [text('depois')] },
    ])
  })

  it('lets a table interrupt a paragraph and requires matching delimiter cells', () => {
    expect(parseMarkdown('Resultado:\na | b\n--- | ---\n1 | 2')).toEqual([
      { type: 'paragraph', children: [text('Resultado:')] },
      { type: 'table', align: [null, null], header: [[text('a')], [text('b')]], rows: [[[text('1')], [text('2')]]] },
    ])
    expect(parseMarkdown('a | b | c\n--- | ---')).toEqual([{ type: 'paragraph', children: [text('a | b | c --- | ---')] }])
    expect(parseMarkdown('título\n---')).toEqual([{ type: 'heading', level: 2, children: [text('título')] }])
  })

  it('builds bullet, numbered and nested lists', () => {
    expect(parseMarkdown('- um\n- dois\n  - dois.a\n\n3. três\n4. quatro')).toEqual([
      {
        type: 'list',
        ordered: false,
        start: 1,
        tight: true,
        items: [
          [{ type: 'paragraph', children: [text('um')] }],
          [
            { type: 'paragraph', children: [text('dois')] },
            { type: 'list', ordered: false, start: 1, tight: true, items: [[{ type: 'paragraph', children: [text('dois.a')] }]] },
          ],
        ],
      },
      {
        type: 'list',
        ordered: true,
        start: 3,
        tight: true,
        items: [[{ type: 'paragraph', children: [text('três')] }], [{ type: 'paragraph', children: [text('quatro')] }]],
      },
    ])
  })

  it('marks the list as loose when blank lines separate items', () => {
    const [list] = parseMarkdown('- um\n\n- dois')
    expect(list).toMatchObject({ type: 'list', tight: false, items: [[{ type: 'paragraph' }], [{ type: 'paragraph' }]] })
  })

  it('accepts unindented continuation in a list item', () => {
    expect(parseMarkdown('- começo\ncontinua')).toEqual([
      {
        type: 'list',
        ordered: false,
        start: 1,
        tight: true,
        items: [[{ type: 'paragraph', children: [text('começo continua')] }]],
      },
    ])
  })

  it('recognizes quotes and horizontal rules', () => {
    expect(parseMarkdown('> **Atenção**\n> leia\n\n***')).toEqual([
      {
        type: 'quote',
        children: [{ type: 'paragraph', children: [{ type: 'strong', children: [text('Atenção')] }, text(' leia')] }],
      },
      { type: 'rule' },
    ])
  })

  it('keeps HTML as literal text', () => {
    expect(parseMarkdown('<script>alert(1)</script>')).toEqual([
      { type: 'paragraph', children: [text('<script>alert(1)</script>')] },
    ])
  })
})

describe('parseInline', () => {
  it('recognizes emphasis, strong, strikethrough and code', () => {
    expect(parseInline('*a* **b** __c__ _d_ ~~e~~ `f *g*`')).toEqual([
      { type: 'em', children: [text('a')] },
      text(' '),
      { type: 'strong', children: [text('b')] },
      text(' '),
      { type: 'strong', children: [text('c')] },
      text(' '),
      { type: 'em', children: [text('d')] },
      text(' '),
      { type: 'del', children: [text('e')] },
      text(' '),
      { type: 'code', text: 'f *g*' },
    ])
  })

  it('nests strong inside emphasis', () => {
    expect(parseInline('*a **b** c*')).toEqual([
      { type: 'em', children: [text('a '), { type: 'strong', children: [text('b')] }, text(' c')] },
    ])
  })

  it('does not treat underscores inside words or a lone asterisk as emphasis', () => {
    expect(parseInline('snake_case_name e 2 * 3 * 4')).toEqual([text('snake_case_name e 2 * 3 * 4')])
  })

  it('honors escapes', () => {
    expect(parseInline('\\*literal\\* e \\[x\\](y)')).toEqual([text('*literal* e [x](y)')])
  })

  it('creates links only for http(s)', () => {
    expect(parseInline('[MR **12**](https://gitlab.com/x/-/merge_requests/12 "título") e [local](/uploads/a.png)')).toEqual([
      {
        type: 'link',
        url: 'https://gitlab.com/x/-/merge_requests/12',
        children: [text('MR '), { type: 'strong', children: [text('12')] }],
      },
      text(' e '),
      text('local'),
    ])
    expect(parseInline('[x](javascript:alert(1))')).toEqual([text('[x](javascript:alert(1))')])
  })

  it('turns images into a link to the file, without loading them', () => {
    expect(parseInline('![captura](https://a.b/c.png)')).toEqual([
      { type: 'link', url: 'https://a.b/c.png', children: [text('captura')] },
    ])
  })

  it('links bare URLs and autolinks, without trailing punctuation', () => {
    expect(parseInline('Veja https://alcy.dev/v2. Ou <https://a.b/c>')).toEqual([
      text('Veja '),
      { type: 'link', url: 'https://alcy.dev/v2', children: [text('https://alcy.dev/v2')] },
      text('. Ou '),
      { type: 'link', url: 'https://a.b/c', children: [text('https://a.b/c')] },
    ])
  })

  it('turns alcy:// links into workspace references, never into URLs', () => {
    expect(parseInline('Abra [Listar **usuários**](alcy://request/req-1) ou ![x](alcy://flow/f1)')).toEqual([
      text('Abra '),
      { type: 'reference', kind: 'request', id: 'req-1', children: [text('Listar '), { type: 'strong', children: [text('usuários')] }] },
      text(' ou '),
      text('x'),
    ])
    expect(parseInline('[a](alcy://request/a/b) alcy://flow/f1')).toEqual([text('a'), text(' alcy://flow/f1')])
  })

  it('does not create a link inside the text of another link', () => {
    expect(parseInline('[https://a.b](https://a.b)')).toEqual([
      { type: 'link', url: 'https://a.b', children: [text('https://a.b')] },
    ])
  })
})
