import { parseTemplate } from '../request-workbench/template-highlight'

interface UrlPreviewProps {
  template: string
  /** Texto do tooltip de uma variável `{{nome}}` da URL. */
  describe: (name: string) => string
}

/** URL com os trechos `{{variável}}` destacados; passar o mouse sobre um deles
 * mostra o valor (`title` nativo, para não ser cortado pelo truncamento). */
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
