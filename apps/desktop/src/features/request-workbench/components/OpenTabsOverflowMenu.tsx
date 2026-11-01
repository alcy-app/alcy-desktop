import { useRef, useState } from 'react'
import { useLanguage } from '../../../shared/i18n/use-language'
import { ChevronDownIcon, PinIcon } from '../../../shared/ui/icons'
import { IconButton } from '../../../shared/ui/IconButton'
import { Input } from '../../../shared/ui/Input'
import type { OpenTabDescriptor } from '../use-open-tabs'
import { RequestMethodBadge } from './RequestMethodBadge'
import { TabMenuSurface } from './TabMenuSurface'

const MENU_WIDTH = 300

/** Lists every open tab with a filter, so tabs scrolled out of the strip stay reachable. */
export function OpenTabsOverflowMenu({ tabs, activeTabId, onSelect }: {
  tabs: OpenTabDescriptor[]
  activeTabId: string | null
  onSelect: (id: string) => void
}) {
  const { t } = useLanguage()
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null)
  const [query, setQuery] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const needle = query.trim().toLocaleLowerCase()
  const matches = needle ? tabs.filter((tab) => tab.label.toLocaleLowerCase().includes(needle)) : tabs

  const close = () => {
    setAnchor(null)
    setQuery('')
  }
  const select = (id: string) => {
    close()
    onSelect(id)
  }

  return (
    <>
      <IconButton
        className="rw-open-tabs-overflow"
        icon={<ChevronDownIcon size={13} />}
        label={t('workbench.openTabs.overflowAria')}
        aria-haspopup="dialog"
        aria-expanded={anchor !== null}
        onClick={(event) => {
          if (anchor) { close(); return }
          const rect = event.currentTarget.getBoundingClientRect()
          setAnchor({ x: rect.right - MENU_WIDTH, y: rect.bottom + 4 })
        }}
      />
      {anchor && (
        <TabMenuSurface x={anchor.x} y={anchor.y} label={t('workbench.openTabs.overflowAria')} onClose={close} dialog>
          <div className="rw-open-tabs-overflow-menu">
            <Input
              className="rw-open-tabs-overflow-search"
              value={query}
              placeholder={t('workbench.openTabs.searchPlaceholder')}
              aria-label={t('workbench.openTabs.searchPlaceholder')}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  listRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
                } else if (event.key === 'Enter' && matches[0]) {
                  event.preventDefault()
                  select(matches[0].id)
                }
              }}
            />
            <div ref={listRef} className="rw-open-tabs-overflow-list">
              {matches.length === 0 && <p className="rw-open-tabs-overflow-empty">{t('workbench.openTabs.searchEmpty')}</p>}
              {matches.map((tab) => {
                const active = tab.id === activeTabId
                return (
                  <button
                    key={tab.id}
                    type="button"
                    className={`ui-menu-item ui-menu-item--with-icon${active ? ' ui-menu-item--selected' : ''}`}
                    aria-current={active || undefined}
                    onClick={() => select(tab.id)}
                  >
                    {tab.fixed && <PinIcon size={11} className="rw-open-tab-pin" />}
                    {tab.request && (
                      <RequestMethodBadge protocol={tab.request.protocol} method={tab.request.method} className="rw-open-tab-method" aria-hidden />
                    )}
                    <span className={`ui-menu-item-label${tab.preview ? ' rw-open-tabs-overflow-preview' : ''}`}>{tab.label}</span>
                    {tab.dirty && <span className="rw-open-tab-dirty-dot rw-open-tab-dirty-dot--visible rw-open-tabs-overflow-dirty" aria-label={t('workbench.tabGroups.unsaved')} />}
                  </button>
                )
              })}
            </div>
          </div>
        </TabMenuSurface>
      )}
    </>
  )
}
