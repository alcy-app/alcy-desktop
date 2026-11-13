import { useId, useRef, useState } from 'react'
import { useLanguage } from '../../shared/i18n/use-language'
import { Input } from '../../shared/ui/Input'
import { IconButton } from '../../shared/ui/IconButton'
import { CloseIcon, SearchIcon } from '../../shared/ui/icons'
import { normalizeSearch, pageAvailable, SETTINGS_INDEX, SETTINGS_PAGES, type SettingsPage } from './settings-navigation'

interface Props {
  page: SettingsPage
  panelId: string
  onNavigate: (page: SettingsPage, target?: string) => void
}

export function SettingsNavigation({ page, panelId, onNavigate }: Props) {
  const { t } = useLanguage()
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLUListElement>(null)
  const resultsId = useId()
  const terms = normalizeSearch(query).split(/\s+/).filter(Boolean)
  const searching = terms.length > 0
  const results = searching ? SETTINGS_INDEX.filter((entry) => {
    if (!pageAvailable(entry.page) || entry.available?.() === false) return false
    const text = normalizeSearch(`${t(entry.label)} ${entry.hint ? t(entry.hint) : ''} ${t(`settings.category.${entry.page}`)} ${entry.keywords ?? ''}`)
    return terms.every((term) => text.includes(term))
  }) : []
  const groups = ['preferences', 'requests', 'tools', 'application'] as const

  return (
    <aside className="settings-sidebar">
      <div className="settings-search" onKeyDown={(event) => {
        if (event.key === 'Escape' && query) {
          event.stopPropagation()
          setQuery('')
        }
        if (event.key === 'ArrowDown' && results.length) {
          event.preventDefault()
          resultsRef.current?.querySelector('button')?.focus()
        }
        if (event.key === 'Enter' && event.target === inputRef.current && results[0]) {
          event.preventDefault()
          onNavigate(results[0].page, results[0].target)
          setQuery('')
        }
      }}>
        <SearchIcon size={14} />
        <Input ref={inputRef} type="search" value={query} aria-label={t('settings.search')} placeholder={t('settings.search')} aria-controls={searching ? resultsId : undefined} onChange={(event) => setQuery(event.target.value)} />
        {query && <IconButton icon={<CloseIcon size={12} />} label={t('settings.searchClear')} onClick={() => { setQuery(''); inputRef.current?.focus() }} />}
      </div>
      {searching ? (
        <div className="settings-search-results">
          <p className="settings-nav-group-label" role="status">{t('settings.searchCount', { count: results.length })}</p>
          <ul id={resultsId} ref={resultsRef} aria-label={t('settings.searchResults')} onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              setQuery('')
              inputRef.current?.focus()
            }
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
            event.preventDefault()
            const buttons = Array.from(resultsRef.current?.querySelectorAll('button') ?? [])
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
            if (event.key === 'ArrowUp' && index === 0) inputRef.current?.focus()
            else buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
          }}>
            {results.map((entry) => <li key={entry.target}><button type="button" onClick={() => { onNavigate(entry.page, entry.target); setQuery('') }}>
              <span>{t(entry.label)}</span>{' '}<small>{t(`settings.category.${entry.page}`)}</small>
            </button></li>)}
          </ul>
          {!results.length && <p className="settings-search-empty">{t('settings.searchEmpty')}</p>}
        </div>
      ) : (
        <nav className="settings-navigation" aria-label={t('settings.categories')}>
          {groups.map((group) => {
            const pages = SETTINGS_PAGES.filter((item) => item.group === group && pageAvailable(item.key))
            return pages.length > 0 && <div className="settings-nav-group" key={group}>
              <p className="settings-nav-group-label">{t(`settings.group.${group}`)}</p>
              {pages.map(({ key, icon: Icon }) => <button key={key} type="button" aria-current={page === key ? 'page' : undefined} aria-controls={`${panelId}-${key}`} className="settings-navigation-item" onClick={() => onNavigate(key)}>
                <Icon size={16} /><span>{t(`settings.category.${key}`)}</span>
              </button>)}
            </div>
          })}
        </nav>
      )}
    </aside>
  )
}
