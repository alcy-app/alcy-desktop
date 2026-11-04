import { Fragment, useMemo, type ReactNode } from 'react'
import { parseMarkdown, type MarkdownBlock, type MarkdownInline, type TableAlign } from './markdown'
import { useOpenExternalLink } from './use-open-external-link'
import './markdown-view.css'

interface MarkdownViewProps {
  renderImage?: (assetId: string, caption: string) => ReactNode
  source: string
  /** Offset headings to fit below the containing page title. */
  headingOffset?: number
  renderCodeBlock?: (text: string, lang?: string) => ReactNode
  /** Renders `alcy://<kind>/<id>` links; without it only their text shows. */
  renderReference?: (kind: string, id: string, children: ReactNode, key: number) => ReactNode
  /** Names a bolded or code-formatted plain text as a reference, rendered by `renderReference`. */
  resolveReference?: (text: string) => { kind: string; id: string } | null
}

/** Render the supported Markdown subset as React elements without raw HTML. */
export function MarkdownView({ source, headingOffset = 0, renderCodeBlock, renderReference, resolveReference, renderImage }: MarkdownViewProps) {
  const blocks = useMemo(() => parseMarkdown(source), [source])
  const openLink = useOpenExternalLink()

  const renderInlines = (nodes: MarkdownInline[]): ReactNode[] =>
    nodes.map((node, index) => {
      switch (node.type) {
        case 'image': return <span key={index}>{renderImage?.(node.assetId, node.caption) ?? node.caption}</span>
        case 'text':
          return node.text
        case 'code': {
          const reference = renderReference && resolveReference?.(node.text)
          if (reference) return renderReference(reference.kind, reference.id, node.text, index)
          return <code key={index}>{node.text}</code>
        }
        case 'strong': {
          const only = node.children.length === 1 ? node.children[0] : null
          const reference = renderReference && only?.type === 'text' && resolveReference?.(only.text)
          if (reference) return renderReference(reference.kind, reference.id, only.text, index)
          return <strong key={index}>{renderInlines(node.children)}</strong>
        }
        case 'em':
          return <em key={index}>{renderInlines(node.children)}</em>
        case 'del':
          return <del key={index}>{renderInlines(node.children)}</del>
        case 'break':
          return <br key={index} />
        case 'reference':
          return renderReference
            ? renderReference(node.kind, node.id, renderInlines(node.children), index)
            : <Fragment key={index}>{renderInlines(node.children)}</Fragment>
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
          // Tight list items render their text without a paragraph wrapper.
          return tight ? <span key={index}>{renderInlines(block.children)}</span> : <p key={index}>{renderInlines(block.children)}</p>
        case 'code':
          if (renderCodeBlock) return <div key={index}>{renderCodeBlock(block.text, block.lang)}</div>
          return (
            <pre key={index}>
              <code>{block.text}</code>
            </pre>
          )
        case 'table':
          // The wrapper scrolls wide tables instead of squeezing their columns.
          return (
            <div key={index} className="markdown-table">
              <table>
                <thead>
                  <tr>
                    {block.header.map((cell, column) => (
                      <th key={column} style={alignStyle(block.align[column])}>{renderInlines(cell)}</th>
                    ))}
                  </tr>
                </thead>
                {block.rows.length > 0 && (
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {row.map((cell, column) => (
                          <td key={column} style={alignStyle(block.align[column])}>{renderInlines(cell)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                )}
              </table>
            </div>
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

function alignStyle(align: TableAlign) {
  return align ? { textAlign: align } : undefined
}
