import { Fragment, useState } from 'react'
import { useLanguage } from '../../shared/i18n/use-language'
import { formatCombo } from '../../shared/shortcuts/shortcuts'
import { IconButton } from '../../shared/ui/IconButton'
import { MenuItem, MenuSeparator, OptionsMenu } from '../../shared/ui/Menu'
import { FormatIcon, PlusIcon } from '../../shared/ui/icons'
import { FORMAT_GROUPS, INSERT_GROUPS, type FormatAction } from './format-actions'
import type { DocumentInsert, MarkdownFormat } from './markdown-format'

/** Markdown format buttons; below a narrow width a container query swaps them for a single menu. */
export function DocumentFormatBar({ disabled, onFormat, onInsert }: { disabled: boolean; onFormat: (format: MarkdownFormat) => void; onInsert: (insert: DocumentInsert) => void }) {
  const { t } = useLanguage()
  const [menuOpen, setMenuOpen] = useState<'format' | 'insert' | null>(null)
  const label = (action: FormatAction) => action.shortcut
    ? `${t(action.label)} (${formatCombo({ ctrl: true, alt: false, shift: false, key: action.shortcut })})`
    : t(action.label)
  return <div className="document-format" role="toolbar" aria-label={t('documents.format.label')}>
    <div className="document-format-buttons">
      {FORMAT_GROUPS.map((group, index) => <Fragment key={group[0].format}>
        {index > 0 && <span className="document-format-separator" aria-hidden="true" />}
        {group.map((action) => <IconButton key={action.format} icon={action.icon} label={label(action)} disabled={disabled}
          // Keep the textarea focused so its selection stays visible while formatting.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onFormat(action.format)} />)}
      </Fragment>)}
    </div>
    {!disabled && <OptionsMenu wrapperClassName="document-format-menu" label={t('documents.format.label')} icon={<FormatIcon size={14} />} isOpen={menuOpen === 'format'}
      onToggle={() => setMenuOpen((open) => open === 'format' ? null : 'format')} onClose={() => setMenuOpen(null)} menuPortal menuAlign="start">
      {FORMAT_GROUPS.map((group, index) => <Fragment key={group[0].format}>
        {index > 0 && <MenuSeparator />}
        {group.map((action) => <MenuItem key={action.format} icon={action.icon} label={label(action)} onSelect={() => { setMenuOpen(null); onFormat(action.format) }} />)}
      </Fragment>)}
    </OptionsMenu>}
    <span className="document-format-separator" aria-hidden="true" />
    {disabled
      ? <span className="ui-button ui-button--ghost ui-button--sm document-insert-button" aria-disabled="true"><PlusIcon size={13} /><span className="ui-button-label">{t('documents.insert.label')}</span></span>
      : <OptionsMenu label={t('documents.insert.label')} buttonClassName="ui-button ui-button--ghost ui-button--sm document-insert-button"
        icon={<><PlusIcon size={13} /><span className="ui-button-label">{t('documents.insert.label')}</span></>}
        isOpen={menuOpen === 'insert'} onToggle={() => setMenuOpen((open) => open === 'insert' ? null : 'insert')} onClose={() => setMenuOpen(null)} menuPortal menuAlign="start">
        {INSERT_GROUPS.map((group, index) => <Fragment key={group[0].insert}>
          {index > 0 && <MenuSeparator />}
          {group.map((action) => <MenuItem key={action.insert} icon={action.icon} label={t(action.label)} onSelect={() => { setMenuOpen(null); onInsert(action.insert) }} />)}
        </Fragment>)}
      </OptionsMenu>}
  </div>
}
