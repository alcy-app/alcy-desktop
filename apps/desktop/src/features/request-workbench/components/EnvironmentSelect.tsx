import { useState } from 'react'
import { useLanguage } from '../../../shared/i18n/use-language'
import { Select } from '../../../shared/ui/Select'
import type { WorkbenchEnvironment } from '../request-workbench.types'

interface EnvironmentSelectProps {
  environments: WorkbenchEnvironment[]
  activeEnvironmentId: string | null
  onChange: (id: string | null) => void
}

export function EnvironmentSelect({ environments, activeEnvironmentId, onChange }: EnvironmentSelectProps) {
  const { t } = useLanguage()
  const [pointerFocus, setPointerFocus] = useState(false)
  const selectedName = environments.find((environment) => environment.id === activeEnvironmentId)?.name
    ?? t('environments.noneOption')
  return (
    <div className="rw-environment-select">
      <Select
        aria-label={t('environments.selectLabel')}
        title={selectedName}
        data-pointer-focus={pointerFocus || undefined}
        onPointerDown={() => setPointerFocus(true)}
        onKeyDown={() => setPointerFocus(false)}
        onBlur={() => setPointerFocus(false)}
        value={activeEnvironmentId ?? ''}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">{t('environments.noneOption')}</option>
        {environments.map((environment) => (
          <option key={environment.id} value={environment.id}>
            {environment.name}
          </option>
        ))}
      </Select>
    </div>
  )
}
