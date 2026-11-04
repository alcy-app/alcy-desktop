import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '../../test-utils'
import { DocumentPreview } from './DocumentPreview'

vi.mock('../../bindings/documentation', () => ({ documentImageUrl: vi.fn(() => new Promise(() => {})) }))

const asset = 'c'.repeat(64)
const markdown = `---
subtitle: Integration guide
author: Platform
cover: true
toc: true
numbering: true
lang: en
---

# Overview

:::tip
Use the sandbox first.
:::

## Requests

![Login response](assets/${asset}.png){width=60%}

| Field | Type |
|---|---|
| id | string |
Table: Fields
`

describe('document preview', () => {
  it('renders the cover, contents, numbering, callouts and numbered captions in the document language', () => {
    render(<DocumentPreview title="Payments API" markdown={markdown} rootPath="/w" documentId="d" themes={[{ id: 'default', name: 'Alcy', accent: '#2f5bd8' }]} />)
    expect(screen.getByRole('heading', { name: 'Payments API' })).toBeInTheDocument()
    expect(screen.getByText('Integration guide')).toBeInTheDocument()
    expect(screen.getByText('Platform')).toBeInTheDocument()
    const contents = screen.getByRole('navigation', { name: 'Contents' })
    expect(within(contents).getByRole('button', { name: /1\.1\s*Requests/ })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /1\s*Overview/ })).toBeInTheDocument()
    expect(screen.getByText('Tip')).toBeInTheDocument()
    expect(screen.getByText('Figure 1:')).toBeInTheDocument()
    expect(screen.getByText('Table 1:')).toBeInTheDocument()
    expect(screen.getAllByRole('separator', { name: 'Page break' })).toHaveLength(1)
  })

  it('shows a title block without a cover and an empty hint without text', () => {
    render(<DocumentPreview title="Notes" markdown="" rootPath="/w" documentId="d" />)
    expect(screen.getByRole('heading', { name: 'Notes' })).toBeInTheDocument()
    expect(screen.getByText(/Nothing to preview yet|Nada para pré-visualizar ainda/)).toBeInTheDocument()
  })
})
