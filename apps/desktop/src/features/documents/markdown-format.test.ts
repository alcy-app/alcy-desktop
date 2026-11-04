import { describe, expect, it } from 'vitest'
import { countWords, formatRelativeTime } from './document-format'
import { applyDocumentInsert, applyMarkdownFormat, imageReference, insertBlock, toggleLinePrefix, wrapSelection } from './markdown-format'

const placeholders = { text: 'text', column: 'Column', cell: 'Value' }
const selected = (edit: { text: string; selectionStart: number; selectionEnd: number }) => edit.text.slice(edit.selectionStart, edit.selectionEnd)

describe('markdown format helpers', () => {
  it('wraps the selection and unwraps it when applied again', () => {
    const bold = wrapSelection('say hello now', 4, 9, '**', '**', 'text')
    expect(bold.text).toBe('say **hello** now')
    expect(selected(bold)).toBe('hello')
    const back = wrapSelection(bold.text, bold.selectionStart, bold.selectionEnd, '**', '**', 'text')
    expect(back.text).toBe('say hello now')
    expect(selected(back)).toBe('hello')
  })

  it('unwraps a selection that includes its own markers', () => {
    expect(wrapSelection('a _b_ c', 2, 5, '_', '_', 'text').text).toBe('a b c')
  })

  it('inserts and selects a placeholder when nothing is selected', () => {
    const edit = applyMarkdownFormat('ab', 1, 1, 'italic', placeholders)
    expect(edit.text).toBe('a_text_b')
    expect(selected(edit)).toBe('text')
  })

  it('selects the URL of a new link so it can be typed over', () => {
    const edit = applyMarkdownFormat('see docs', 4, 8, 'link', placeholders)
    expect(edit.text).toBe('see [docs](https://)')
    expect(selected(edit)).toBe('https://')
  })

  it('turns a multi-line selection into a fenced code block', () => {
    const edit = applyMarkdownFormat('intro\nconst a = 1\nconst b = 2\nend', 6, 29, 'code', placeholders)
    expect(edit.text).toBe('intro\n\n```\nconst a = 1\nconst b = 2\n```\n\nend')
    expect(selected(edit)).toBe('const a = 1\nconst b = 2')
  })

  it('toggles a prefix on every selected line, skipping blank lines', () => {
    const text = 'one\n\ntwo\nthree'
    const listed = toggleLinePrefix(text, 0, text.length, 'bullet')
    expect(listed.text).toBe('- one\n\n- two\n- three')
    expect(toggleLinePrefix(listed.text, 0, listed.text.length, 'bullet').text).toBe(text)
  })

  it('numbers ordered lists and replaces another block prefix', () => {
    expect(toggleLinePrefix('- a\n- b', 0, 7, 'ordered').text).toBe('1. a\n2. b')
    expect(toggleLinePrefix('# Title', 3, 3, 'heading').text).toBe('Title')
    expect(toggleLinePrefix('> quoted', 0, 0, 'heading').text).toBe('## quoted')
  })

  it('keeps the caret on the same text when prefixing one line', () => {
    const edit = toggleLinePrefix('first\nsecond', 9, 9, 'quote')
    expect(edit.text).toBe('first\n> second')
    expect(edit.selectionStart).toBe(11)
  })

  it('inserts blocks on their own paragraph', () => {
    expect(insertBlock('para', 4, 4, '---').text).toBe('para\n\n---\n')
    expect(insertBlock('', 0, 0, '---').text).toBe('---\n')
    const table = applyMarkdownFormat('a\n\nb', 2, 2, 'table', placeholders)
    expect(table.text).toBe('a\n\n| Column | Column |\n| --- | --- |\n| Value | Value |\n\nb')
    expect(selected(table)).toBe('Column')
  })

  it('builds image references with a safe caption and placement', () => {
    expect(imageReference('a'.repeat(64), 'Login [ok]\nresponse')).toBe(`![Login ok response](assets/${'a'.repeat(64)}.png)`)
    expect(imageReference('b'.repeat(64), 'Chart', { width: 50, align: 'right' })).toBe(`![Chart](assets/${'b'.repeat(64)}.png){width=50% align=right}`)
  })
})

describe('document inserts', () => {
  const words = { title: 'Title', text: 'text', column: 'Column', caption: 'Caption' }

  it('wraps a selection in a callout and selects its title', () => {
    const edit = applyDocumentInsert('Intro\nKeep it short.', 6, 20, 'warning', words)
    expect(edit.text).toBe('Intro\n\n:::warning Title\nKeep it short.\n:::\n')
    expect(selected(edit)).toBe('Title')
  })

  it('inserts columns, page breaks and a placed table of contents', () => {
    const columns = applyDocumentInsert('', 0, 0, 'columns3', words)
    expect(columns.text).toBe(':::columns\nColumn 1\n+++\nColumn 2\n+++\nColumn 3\n:::\n')
    expect(applyDocumentInsert('a', 1, 1, 'pagebreak', words).text).toBe('a\n\n\\pagebreak\n')
    expect(applyDocumentInsert('a', 1, 1, 'toc', words).text).toBe('a\n\n[[toc]]\n')
  })

  it('places a table caption right after the table around the cursor', () => {
    const table = '| A | B |\n|---|---|\n| 1 | 2 |\n\nAfter'
    const edit = applyDocumentInsert(table, 2, 2, 'tableCaption', words)
    expect(edit.text).toBe('| A | B |\n|---|---|\n| 1 | 2 |\nTable: Caption\n\nAfter')
    expect(selected(edit)).toBe('Caption')
  })
})

describe('document display helpers', () => {
  it('counts words without Markdown syntax tokens', () => {
    expect(countWords('# Title\n\n- one item | two\n\n---')).toBe(4)
    expect(countWords('   ')).toBe(0)
  })

  it('formats recent times relatively and old ones as dates', () => {
    const now = Date.UTC(2026, 10, 4, 12)
    expect(formatRelativeTime(now - 5_000, 'en', now)).toBe('now')
    expect(formatRelativeTime(now - 3 * 3_600_000, 'en', now)).toBe('3 hours ago')
    expect(formatRelativeTime(now - 86_400_000, 'en', now)).toBe('yesterday')
    expect(formatRelativeTime(now - 30 * 86_400_000, 'en', now)).toMatch(/2026/)
  })
})
