import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { LanguageContext } from '../../shared/i18n/language-context'
import { translate, type Language } from '../../shared/i18n/translations'
import { ThemeContext } from '../../shared/appearance/theme-context'
import type { Theme } from '../../shared/appearance/theme'
import { FLOW_TEMPLATES } from './flow-templates'
import { FlowTemplatePreview } from './FlowTemplatePreview'

function preview(language: Language, theme: Theme) {
  return <LanguageContext value={{ language, t: (key) => translate(language, key), setLanguage: () => {} }}>
    <ThemeContext value={{ theme, preference: theme, setPreference: () => {} }}>
      {FLOW_TEMPLATES.map(({ id }) => <FlowTemplatePreview key={id} templateId={id} />)}
    </ThemeContext>
  </LanguageContext>
}

describe('static flow template images', () => {
  it.each(['en', 'pt-BR'] as const)('bundles every %s template in both themes without mounting canvases', (language) => {
    const { container, rerender } = render(preview(language, 'light'))
    const verify = (theme: Theme) => {
      const images = container.querySelectorAll('img')
      expect(images).toHaveLength(FLOW_TEMPLATES.length)
      images.forEach((image, index) => {
        expect(image).toHaveAttribute('src', expect.stringContaining(`${FLOW_TEMPLATES[index].id}-${language}-${theme}.png`))
        expect(image).toHaveAttribute('loading', 'lazy')
        expect(image).toHaveAttribute('alt', '')
      })
      expect(container.querySelector('.react-flow')).not.toBeInTheDocument()
      expect(container.querySelector('canvas')).not.toBeInTheDocument()
      expect(container.querySelector('button')).not.toBeInTheDocument()
    }
    verify('light')
    rerender(preview(language, 'dark'))
    verify('dark')
  })
})
