import { useMemo } from 'react'
import { useLanguage } from '../../../shared/i18n/use-language'
import { countLines } from '../line-count'

interface LineCountProps {
  text: string
  className?: string
}

export function LineCount({ text, className }: LineCountProps) {
  const { t } = useLanguage()
  // O texto pode ser o corpo inteiro de uma resposta grande: só recontar quando ele muda.
  const count = useMemo(() => countLines(text), [text])
  const label = count === 1 ? t('common.lineCountOne', { count }) : t('common.lineCount', { count })
  return <span className={className ? `rw-line-count ${className}` : 'rw-line-count'}>{label}</span>
}
