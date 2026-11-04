import { useMemo } from 'react'
import { parseMarkdown } from './markdown'
import { useMarkdownRenderer, type MarkdownRendererOptions } from './use-markdown-renderer'
import './markdown-view.css'

interface MarkdownViewProps extends MarkdownRendererOptions {
  source: string
}

/** Render the supported Markdown subset as React elements without raw HTML. */
export function MarkdownView({ source, ...options }: MarkdownViewProps) {
  const blocks = useMemo(() => parseMarkdown(source), [source])
  const { renderBlocks } = useMarkdownRenderer(options)
  return <div className="markdown-view">{renderBlocks(blocks)}</div>
}
