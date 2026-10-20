import { useState } from 'react'
import { useLanguage } from '../../shared/i18n/use-language'
import { Button } from '../../shared/ui/Button'
import { Field } from '../../shared/ui/Field'
import { Input } from '../../shared/ui/Input'
import { identifierError } from './node-identifiers'

export function NodeIdentifierField({ nodeId, nodes, disabled, onRename }: { nodeId: string; nodes: readonly { id: string }[]; disabled?: boolean; onRename: (id: string) => void }) {
  const { t } = useLanguage()
  const [value, setValue] = useState(nodeId)
  const next = value.trim()
  const error = identifierError(next, nodeId, nodes)
  const changed = next !== nodeId
  const apply = () => { if (!disabled && !error && next !== nodeId) onRename(next) }
  return <div data-flow-map="false" className="flow-node-identifier">
    <Field label={t('flows.studio.identifier')} hint={error ? undefined : t('flows.studio.identifierHint')}>
      {(id) => <div className="flow-node-identifier-input"><span aria-hidden="true" className="flow-node-identifier-prefix">nodes.</span><Input id={id} mono title={nodeId} value={value} autoComplete="off" spellCheck={false} placeholder="login" maxLength={64} disabled={disabled} aria-invalid={Boolean(error)} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); apply() } if (event.key === 'Escape') { event.stopPropagation(); setValue(nodeId) } }} />{changed && <Button size="sm" variant="primary" disabled={disabled || Boolean(error)} onClick={apply}>{t('flows.studio.renameIdentifier')}</Button>}</div>}
    </Field>
    {error && <p role="alert" className="flow-node-identifier-error">{t(error === 'duplicate' ? 'flows.studio.identifierDuplicate' : 'flows.studio.identifierInvalid')}</p>}
  </div>
}
