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
  return (
    <div className="rw-environment-select">
      <Select
        aria-label={t('environments.selectLabel')}
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
