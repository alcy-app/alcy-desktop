import { useMemo } from 'react'
import { parseMarkdown, type MarkdownBlock, type MarkdownInline } from './markdown'
import { useOpenExternalLink } from './use-open-external-link'
import './markdown-view.css'

interface MarkdownViewProps {
  source: string
  /** Soma aos níveis dos títulos para encaixá-los abaixo do título da página. */
  headingOffset?: number
}

/** Renderiza o subconjunto de Markdown de `markdown.ts` como elementos React, sem HTML cru. */
export function MarkdownView({ source, headingOffset = 0 }: MarkdownViewProps) {
  const blocks = useMemo(() => parseMarkdown(source), [source])
  const openLink = useOpenExternalLink()

  const renderInlines = (nodes: MarkdownInline[]) =>
    nodes.map((node, index) => {
      switch (node.type) {
        case 'text':
          return node.text
        case 'code':
          return <code key={index}>{node.text}</code>
        case 'strong':
          return <strong key={index}>{renderInlines(node.children)}</strong>
        case 'em':
          return <em key={index}>{renderInlines(node.children)}</em>
        case 'del':
          return <del key={index}>{renderInlines(node.children)}</del>
        case 'break':
          return <br key={index} />
        case 'link':
          return (
            <a
              key={index}
              href={node.url}
              title={node.url}
              onClick={(event) => openLink(event, node.url)}
              onAuxClick={(event) => openLink(event, node.url)}
            >
              {renderInlines(node.children)}
            </a>
          )
      }
    })

  const renderBlocks = (nodes: MarkdownBlock[], tight = false) =>
    nodes.map((block, index) => {
      switch (block.type) {
        case 'heading': {
          const Heading = `h${Math.min(block.level + headingOffset, 6)}` as 'h1'
          return <Heading key={index}>{renderInlines(block.children)}</Heading>
        }
        case 'paragraph':
          // Em listas compactas o texto do item fica sem <p>, como no GitLab.
          return tight ? <span key={index}>{renderInlines(block.children)}</span> : <p key={index}>{renderInlines(block.children)}</p>
        case 'code':
          return (
            <pre key={index}>
              <code>{block.text}</code>
            </pre>
          )
        case 'quote':
          return <blockquote key={index}>{renderBlocks(block.children)}</blockquote>
        case 'rule':
          return <hr key={index} />
        case 'list': {
          const items = block.items.map((item, itemIndex) => <li key={itemIndex}>{renderBlocks(item, block.tight)}</li>)
          return block.ordered ? (
            <ol key={index} start={block.start === 1 ? undefined : block.start}>
              {items}
            </ol>
          ) : (
            <ul key={index}>{items}</ul>
          )
        }
      }
    })

  return <div className="markdown-view">{renderBlocks(blocks)}</div>
}
