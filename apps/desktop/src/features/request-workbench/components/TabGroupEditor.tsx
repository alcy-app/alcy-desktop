import { useState } from 'react'
import type { CSSProperties } from 'react'
import { useLanguage } from '../../../shared/i18n/use-language'
import { Input } from '../../../shared/ui/Input'
import { MenuItem, MenuSeparator } from '../../../shared/ui/Menu'
import { CheckIcon } from '../../../shared/ui/icons'
import { LABEL_COLORS } from '../collection-labels'
import { TAB_GROUP_NAME_LIMIT } from '../tab-groups'
import type { TabGroup } from '../tab-groups'
import { TabMenuSurface } from './TabMenuSurface'

export function TabGroupEditor({ group, x, y, onClose, onUpdate, onUngroup, onCloseTabs }: {
  group: TabGroup
  x: number
  y: number
  onClose: () => void
  onUpdate: (patch: Partial<Pick<TabGroup, 'name' | 'color' | 'collapsed'>>) => void
  onUngroup: () => void
  onCloseTabs: () => void
}) {
  const { t } = useLanguage()
  const [name, setName] = useState(group.name)
  const saveName = () => {
    if (!name.trim()) setName(group.name)
    else if (name.trim() !== group.name) onUpdate({ name })
  }
  return (
    <TabMenuSurface x={x} y={y} label={t('workbench.tabGroups.edit')} onClose={() => { saveName(); onClose() }} dialog>
      <div className="rw-tab-group-editor">
        <label className="rw-tab-group-field">
          <span>{t('workbench.tabGroups.name')}</span>
          <Input
            value={name}
            maxLength={TAB_GROUP_NAME_LIMIT}
            onChange={(event) => setName(event.target.value)}
            onBlur={saveName}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { saveName(); onClose() }
              if (event.key === 'Escape') { event.stopPropagation(); onClose() }
            }}
          />
        </label>
        <div className="rw-tab-group-colors" role="group" aria-label={t('workbench.tabGroups.color')}>
          {LABEL_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className="rw-tab-group-swatch"
              style={{ '--tab-group-color': `var(--label-${color})` } as CSSProperties}
              aria-label={t(`collections.labels.color.${color}`)}
              aria-pressed={group.color === color}
              onClick={() => { saveName(); onUpdate({ color }) }}
            >{group.color === color && <CheckIcon size={12} />}</button>
          ))}
        </div>
      </div>
      <MenuSeparator />
      <MenuItem label={t(group.collapsed ? 'workbench.tabGroups.expand' : 'workbench.tabGroups.collapse')} onSelect={() => { saveName(); onUpdate({ collapsed: !group.collapsed }); onClose() }} />
      <MenuItem label={t('workbench.tabGroups.ungroup')} onSelect={() => { onUngroup(); onClose() }} />
      <MenuSeparator />
      <MenuItem danger label={t('workbench.tabGroups.close', { tabs: t(group.tabIds.length === 1 ? 'workbench.tabGroups.singleTab' : 'workbench.tabGroups.tabCount', { count: group.tabIds.length }) })} onSelect={() => { onCloseTabs(); onClose() }} />
    </TabMenuSurface>
  )
}
