import { useTheme } from '../../shared/appearance/use-theme'
import { useLanguage } from '../../shared/i18n/use-language'
import type { FlowTemplateId } from './flow-templates'

const images = import.meta.glob<string>('./template-images/*.png', { eager: true, query: '?url', import: 'default' })

/** Static captures of the actual node renderer; opening the gallery mounts no canvases. */
export function FlowTemplatePreview({ templateId }: { templateId: FlowTemplateId }) {
  const { language } = useLanguage()
  const { theme } = useTheme()
  const src = images[`./template-images/${templateId}-${language}-${theme}.png`]
  return <img className="flow-template-preview" src={src} width={960} height={420} alt="" aria-hidden="true" loading="lazy" decoding="async" draggable={false} />
}
