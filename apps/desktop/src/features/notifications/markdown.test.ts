import { describe, expect, it } from 'vitest'
import { parseInline, parseMarkdown } from './markdown'

const text = (value: string) => ({ type: 'text', text: value })

describe('parseMarkdown', () => {
  it('reconhece títulos ATX e setext', () => {
    expect(parseMarkdown('# Novidades #\n\nResumo\n---\n\n###### Fim')).toEqual([
      { type: 'heading', level: 1, children: [text('Novidades')] },
      { type: 'heading', level: 2, children: [text('Resumo')] },
      { type: 'heading', level: 6, children: [text('Fim')] },
    ])
  })

  it('não trata #hashtag como título', () => {
    expect(parseMarkdown('#123 corrigido')).toEqual([{ type: 'paragraph', children: [text('#123 corrigido')] }])
  })

  it('junta linhas do parágrafo e respeita quebras forçadas', () => {
    expect(parseMarkdown('linha 1\nlinha 2  \nlinha 3\\\nlinha 4\n\noutro')).toEqual([
      {
        type: 'paragraph',
        children: [text('linha 1 linha 2'), { type: 'break' }, text('linha 3'), { type: 'break' }, text('linha 4')],
      },
      { type: 'paragraph', children: [text('outro')] },
    ])
  })

  it('preserva blocos de código cercados', () => {
    expect(parseMarkdown('```bash\npnpm check\n  # *sem* markdown\n```\ndepois')).toEqual([
      { type: 'code', text: 'pnpm check\n  # *sem* markdown' },
      { type: 'paragraph', children: [text('depois')] },
    ])
  })

  it('monta listas simples, numeradas e aninhadas', () => {
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

  it('marca a lista como espaçada quando há linhas em branco entre os itens', () => {
    const [list] = parseMarkdown('- um\n\n- dois')
    expect(list).toMatchObject({ type: 'list', tight: false, items: [[{ type: 'paragraph' }], [{ type: 'paragraph' }]] })
  })

  it('aceita continuação sem recuo no item da lista', () => {
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

  it('reconhece citações e linhas horizontais', () => {
    expect(parseMarkdown('> **Atenção**\n> leia\n\n***')).toEqual([
      {
        type: 'quote',
        children: [{ type: 'paragraph', children: [{ type: 'strong', children: [text('Atenção')] }, text(' leia')] }],
      },
      { type: 'rule' },
    ])
  })

  it('mantém HTML como texto literal', () => {
    expect(parseMarkdown('<script>alert(1)</script>')).toEqual([
      { type: 'paragraph', children: [text('<script>alert(1)</script>')] },
    ])
  })
})

describe('parseInline', () => {
  it('reconhece ênfase, negrito, tachado e código', () => {
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

  it('aninha negrito dentro de ênfase', () => {
    expect(parseInline('*a **b** c*')).toEqual([
      { type: 'em', children: [text('a '), { type: 'strong', children: [text('b')] }, text(' c')] },
    ])
  })

  it('não trata sublinhado dentro de palavras nem asterisco solto como ênfase', () => {
    expect(parseInline('snake_case_name e 2 * 3 * 4')).toEqual([text('snake_case_name e 2 * 3 * 4')])
  })

  it('respeita escapes', () => {
    expect(parseInline('\\*literal\\* e \\[x\\](y)')).toEqual([text('*literal* e [x](y)')])
  })

  it('cria links só para http(s)', () => {
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

  it('transforma imagens em link para o arquivo, sem carregá-las', () => {
    expect(parseInline('![captura](https://a.b/c.png)')).toEqual([
      { type: 'link', url: 'https://a.b/c.png', children: [text('captura')] },
    ])
  })

  it('cria links para URLs soltas e autolinks, sem a pontuação final', () => {
    expect(parseInline('Veja https://alcy.dev/v2. Ou <https://a.b/c>')).toEqual([
      text('Veja '),
      { type: 'link', url: 'https://alcy.dev/v2', children: [text('https://alcy.dev/v2')] },
      text('. Ou '),
      { type: 'link', url: 'https://a.b/c', children: [text('https://a.b/c')] },
    ])
  })

  it('não cria link dentro do texto de outro link', () => {
    expect(parseInline('[https://a.b](https://a.b)')).toEqual([
      { type: 'link', url: 'https://a.b', children: [text('https://a.b')] },
    ])
  })
})
