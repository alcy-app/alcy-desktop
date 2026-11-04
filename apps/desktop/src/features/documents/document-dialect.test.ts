import { describe, expect, it } from 'vitest'
import { inlineText, parseDocument, setFrontMatter, type DocBlock } from './document-dialect'

// Mirrors the cases in crates/alcy-app/src/documentation_markdown.rs.
const text = (block: DocBlock | undefined) => block?.type === 'markdown' && (block.block.type === 'paragraph' || block.block.type === 'heading') ? inlineText(block.block.children) : ''

describe('document dialect', () => {
  it('reads a metadata block only when every line is key: value', () => {
    const doc = parseDocument('---\nsubtitle: API v2\nauthor: "Ana"\ncover: true\nnumbering: sim\n---\n\n# Intro\n')
    expect(doc.meta).toMatchObject({ subtitle: 'API v2', author: 'Ana', cover: true, numbering: true, toc: false })
    const prose = parseDocument('---\nNot metadata here.\n---\n')
    expect(prose.meta).toEqual({ cover: false, toc: false, numbering: false })
    expect(prose.blocks.length).toBeGreaterThan(0)
  })

  it('parses callouts, columns, page control and alignment', () => {
    const doc = parseDocument(':::warning Rate limit\nKeep **under** 10 rps.\n:::\n\n:::columns\nLeft\n+++\nRight\n:::\n\n\\pagebreak\n[[toc]]\n\n:::center\nCentered\n:::\n')
    const [callout, columns, pagebreak, toc, centered] = doc.blocks
    expect(callout).toMatchObject({ type: 'callout', kind: 'warning', title: 'Rate limit' })
    expect(callout.type === 'callout' && text(callout.children[0])).toBe('Keep under 10 rps.')
    expect(columns.type === 'columns' && columns.columns.map((column) => text(column[0]))).toEqual(['Left', 'Right'])
    expect(pagebreak).toEqual({ type: 'pagebreak' })
    expect(toc).toEqual({ type: 'toc' })
    expect(centered).toMatchObject({ type: 'markdown', align: 'center' })
  })

  it('keeps container markers inside code fences as code', () => {
    const doc = parseDocument('```text\n:::note\n\\pagebreak\n```\n')
    expect(doc.blocks).toHaveLength(1)
    expect(doc.blocks[0]).toMatchObject({ type: 'markdown', block: { type: 'code', text: ':::note\n\\pagebreak' } })
  })

  it('numbers headings, captioned figures and captioned tables', () => {
    const asset = `assets/${'a'.repeat(64)}.png`
    const doc = parseDocument(`---\nnumbering: true\n---\n# One\n## Sub\n# Two\n\n![Login](${asset}){width=50% align=right}\n\n| A | B |\n|---|--:|\n| 1 | 2 |\nTable: Results\n\n![](${asset})\n`)
    expect(doc.outline.map((entry) => entry.number)).toEqual(['1', '1.1', '2'])
    const figure = doc.blocks[3]
    const image = figure.type === 'markdown' && figure.block.type === 'paragraph' ? figure.block.children[0] : null
    expect(image).toMatchObject({ type: 'image', caption: 'Login', width: 0.5, align: 'right' })
    expect(image && doc.figureNumbers.get(image)).toBe(1)
    const table = doc.blocks[4]
    expect(table).toMatchObject({ type: 'markdown', caption: 'Results', block: { type: 'table' } })
    expect(table.type === 'markdown' && doc.tableNumbers.get(table.block)).toBe(1)
    expect(doc.figureNumbers.size).toBe(1)
  })

  it('edits metadata while keeping the body and unknown keys', () => {
    expect(setFrontMatter('# Body\n', { author: 'Ana', cover: 'true' })).toBe('---\nauthor: Ana\ncover: true\n---\n\n# Body\n')
    expect(setFrontMatter('---\nowner: ops\nauthor: Ana\n---\n\n# Body\n', { author: null })).toBe('---\nowner: ops\n---\n\n# Body\n')
    expect(setFrontMatter('---\nauthor: Ana\n---\n\nText', { author: null })).toBe('Text')
    expect(setFrontMatter('---\ntoc: true\n---\n\nText', { subtitle: 'Guide' })).toBe('---\nsubtitle: Guide\ntoc: true\n---\n\nText')
  })
})
