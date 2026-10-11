import { memo, useState } from 'react'
import { parseBulk, serializeBulk, type BulkRow } from '../../../shared/bulk-edit'
import type { EnvironmentVariableDto } from '../../../bindings/list-environments'
import { useLanguage } from '../../../shared/i18n/use-language'
import { BulkEditor } from '../../../shared/ui/BulkEditor'
import { BulkEditToggle } from '../../../shared/ui/BulkEditToggle'
import { Button } from '../../../shared/ui/Button'
import { Checkbox } from '../../../shared/ui/Checkbox'
import { IconButton } from '../../../shared/ui/IconButton'
import { PlusIcon, TrashIcon } from '../../../shared/ui/icons'
import type { ParamEntry, RouteParamEntry } from '../request-workbench.types'
import type { FieldSuggestion } from '../schema-completions'
import { TemplateHighlightedField } from './TemplateHighlightedField'

interface ParamsPanelProps {
  routeParams: RouteParamEntry[]
  onUpdateRouteParam: (id: string, value: string) => void
  onUpdateRouteParamName: (id: string, name: string) => void
  onRemoveRouteParam: (id: string) => void
  params: ParamEntry[]
  onAdd: () => void
  onUpdate: (id: string, patch: Partial<Omit<ParamEntry, 'id'>>) => void
  onRemove: (id: string) => void
  /** Variáveis do ambiente ativo — destaque, tooltip e sugestões de `{{variável}}` nos campos interpolados. */
  environmentVariables: EnvironmentVariableDto[]
  onReplaceAll: (rows: BulkRow[]) => void
  /** Nomes documentados (documentação importada); ausente = sem sugestões. */
  nameSuggestions?: FieldSuggestion[]
  /** Valores conhecidos do parâmetro de nome `name`. */
  valueSuggestionsFor?: (name: string) => FieldSuggestion[]
}

export const ParamsPanel = memo(function ParamsPanel({
  routeParams,
  onUpdateRouteParam,
  onUpdateRouteParamName,
  onRemoveRouteParam,
  params,
  onAdd,
  onUpdate,
  onRemove,
  onReplaceAll,
  environmentVariables,
  nameSuggestions,
  valueSuggestionsFor,
}: ParamsPanelProps) {
  const { t } = useLanguage()
  // `null` = tabela; string = texto em edição (rascunho local, aplicado a cada alteração).
  const [bulkText, setBulkText] = useState<string | null>(null)
  return (
    <div className="rw-panel rw-params-panel">
      {routeParams.length > 0 && (
        <section className="rw-params-section" aria-labelledby="route-params-title">
          <h3 id="route-params-title" className="rw-params-section-title">
            {t('params.routeTitle')}
          </h3>
          <table className="rw-headers-table rw-headers-table--grid rw-route-params-table">
            <caption className="rw-visually-hidden">{t('params.routeCaption')}</caption>
            <colgroup>
              <col />
              <col />
              <col style={{ width: '44px' }} />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">{t('common.name')}</th>
                <th scope="col">{t('common.value')}</th>
                <th scope="col">
                  <span className="rw-visually-hidden">{t('common.remove')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {routeParams.map((routeParam) => (
                <tr key={routeParam.id}>
                  <td>
                    <label className="rw-visually-hidden" htmlFor={'route-param-name-' + routeParam.id}>
                      {t('params.routeNameFieldLabel', { name: routeParam.name || t('common.unnamed') })}
                    </label>
                    <input
                      id={'route-param-name-' + routeParam.id}
                      className="ui-input rw-route-param-name"
                      value={routeParam.name}
                      onChange={(event) => onUpdateRouteParamName(routeParam.id, event.target.value)}
                      placeholder={t('common.name')}
                      spellCheck={false}
                      autoComplete="off"
                    />
                  </td>
                  <td>
                    <label className="rw-visually-hidden" htmlFor={'route-param-value-' + routeParam.id}>
                      {t('params.routeValueFieldLabel', { name: routeParam.name })}
                    </label>
                    <TemplateHighlightedField
                      id={'route-param-value-' + routeParam.id}
                      fieldClassName="ui-input"
                      value={routeParam.value}
                      onChange={(value) => onUpdateRouteParam(routeParam.id, value)}
                      variables={environmentVariables}
                      placeholder={t('common.value')}
                    />
                  </td>
                  <td>
                    <IconButton
                      variant="danger"
                      icon={<TrashIcon size={13} />}
                      label={t('params.removeRouteAria', { name: routeParam.name })}
                      onClick={() => onRemoveRouteParam(routeParam.id)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      <section className="rw-params-section" aria-labelledby="query-params-title">
        <div className="rw-params-section-header">
          <h3 id="query-params-title" className="rw-params-section-title">
            {t('params.queryTitle')}
          </h3>
          <BulkEditToggle
            bulk={bulkText !== null}
            onChange={(bulk) => setBulkText(bulk ? serializeBulk(params) : null)}
          />
        </div>
        {bulkText !== null ? (
          <BulkEditor
            value={bulkText}
            ariaLabel={t('bulk.paramsAria')}
            onChange={(text) => {
              setBulkText(text)
              onReplaceAll(parseBulk(text))
            }}
          />
        ) : (
          <>
            <table className="rw-headers-table rw-headers-table--grid">
              <caption className="rw-visually-hidden">{t('params.caption')}</caption>
              <colgroup>
                <col style={{ width: '36px' }} />
                <col />
                <col />
                <col style={{ width: '44px' }} />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">
                    <span className="rw-visually-hidden">{t('params.enabledColumn')}</span>
                  </th>
                  <th scope="col">{t('common.name')}</th>
                  <th scope="col">{t('common.value')}</th>
                  <th scope="col">
                    <span className="rw-visually-hidden">{t('common.remove')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {params.map((param) => (
                  <tr key={param.id}>
                    <td>
                      <label className="rw-visually-hidden" htmlFor={`param-enabled-${param.id}`}>
                        {t('params.enableAria', { name: param.name || t('common.unnamed') })}
                      </label>
                      <Checkbox
                        id={`param-enabled-${param.id}`}
                        checked={param.enabled}
                        onChange={(event) => onUpdate(param.id, { enabled: event.target.checked })}
                      />
                    </td>
                    <td>
                      <label className="rw-visually-hidden" htmlFor={`param-name-${param.id}`}>
                        {t('params.nameFieldLabel')}
                      </label>
                      <TemplateHighlightedField
                        id={`param-name-${param.id}`}
                        fieldClassName="ui-input"
                        value={param.name}
                        onChange={(name) => onUpdate(param.id, { name })}
                        variables={environmentVariables}
                        placeholder={t('common.name')}
                        suggestions={nameSuggestions}
                      />
                    </td>
                    <td>
                      <label className="rw-visually-hidden" htmlFor={`param-value-${param.id}`}>
                        {t('params.valueFieldLabel')}
                      </label>
                      <TemplateHighlightedField
                        id={`param-value-${param.id}`}
                        fieldClassName="ui-input"
                        value={param.value}
                        onChange={(value) => onUpdate(param.id, { value })}
                        variables={environmentVariables}
                        placeholder={t('common.value')}
                        suggestions={valueSuggestionsFor?.(param.name)}
                      />
                    </td>
                    <td>
                      <IconButton
                        variant="danger"
                        icon={<TrashIcon size={13} />}
                        label={t('params.removeAria', { name: param.name || t('common.unnamed') })}
                        onClick={() => onRemove(param.id)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Button variant="ghost" onClick={onAdd}>
              <PlusIcon size={12} />
              {t('params.addButton')}
            </Button>
          </>
        )}
      </section>
    </div>
  )
})
