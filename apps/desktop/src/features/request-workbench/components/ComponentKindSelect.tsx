import { useState } from 'react'
import type { ReactNode } from 'react'
import { useLanguage } from '../../../shared/i18n/use-language'
import { MenuItem, OptionsMenu } from '../../../shared/ui/Menu'
import { ChevronDownIcon, FlowIcon, FolderIcon, MockServerIcon } from '../../../shared/ui/icons'

export type ComponentKind = 'collections' | 'flows' | 'mockServers'

interface ComponentKindSelectProps {
  value: ComponentKind
  onChange: (value: ComponentKind) => void
}

/** Seletor do tipo de componente exibido no cabeçalho da barra lateral. */
export function ComponentKindSelect({ value, onChange }: ComponentKindSelectProps) {
  const { t } = useLanguage()
  const [isOpen, setIsOpen] = useState(false)

  const options = [
    { id: 'collections', label: t('environments.collectionsTab'), icon: <FolderIcon size={14} /> },
    { id: 'flows', label: t('flows.subTabLabel'), icon: <FlowIcon size={14} /> },
    { id: 'mockServers', label: t('mockServers.title'), icon: <MockServerIcon size={14} /> },
  ] satisfies Array<{ id: ComponentKind; label: string; icon: ReactNode }>
  const current = options.find((option) => option.id === value) ?? options[0]

  return (
    <OptionsMenu
      label={t('components.kindAria')}
      isOpen={isOpen}
      onToggle={() => setIsOpen((open) => !open)}
      onClose={() => setIsOpen(false)}
      wrapperClassName="component-kind-host"
      buttonClassName="component-kind-trigger"
      menuClassName="component-kind-menu"
      icon={
        <>
          {current.icon}
          <span className="component-kind-label">{current.label}</span>
          <ChevronDownIcon size={12} className="component-kind-chevron" />
        </>
      }
    >
      {options.map((option) => (
        <MenuItem
          key={option.id}
          label={option.label}
          selected={option.id === value}
          autoFocus={option.id === value}
          onSelect={() => {
            onChange(option.id)
            setIsOpen(false)
          }}
        />
      ))}
    </OptionsMenu>
  )
}
