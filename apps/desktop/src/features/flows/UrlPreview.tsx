import { parseTemplate } from '../request-workbench/template-highlight'

interface UrlPreviewProps {
  template: string
  /** Tooltip for a URL variable placeholder. */
  describe: (name: string) => string
}

/** Highlight URL placeholders with a native tooltip that survives truncation. */
export function UrlPreview({ template, describe }: UrlPreviewProps) {
  return (
    <>
      {parseTemplate(template).map((segment, index) =>
        segment.type === 'text' ? (
          <span key={index}>{segment.value}</span>
        ) : (
          <span key={index} className="flow-url-variable" title={describe(segment.name)}>
            {segment.raw}
          </span>
        ),
      )}
    </>
  )
}
