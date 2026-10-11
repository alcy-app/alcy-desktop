import { memo, type ReactNode } from 'react'
import type { EnvironmentVariableDto } from '../../../bindings/list-environments'
import { useLanguage } from '../../../shared/i18n/use-language'
import type { InheritedAuthenticationSource } from '../collection-tree'
import type { AuthorizationState, AuthorizationType } from '../request-workbench.types'
import { OptionSelect, type SelectOption } from './OptionSelect'
import { TemplateHighlightedField } from './TemplateHighlightedField'

const TYPE_LABEL_KEYS = {
  none: 'authorization.typeNone',
  customHeader: 'authorization.typeCustomHeader',
  bearer: 'authorization.typeBearer',
  basic: 'authorization.typeBasic',
  digest: 'authorization.typeDigest',
  oauth2ClientCredentials: 'authorization.typeOAuth2ClientCredentials',
} as const

/** Linha rótulo + controle do formulário em grade, no mesmo padrão visual das tabelas de Headers/Params. */
function AuthRow({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="rw-auth-row">
      <label className="rw-auth-label" htmlFor={htmlFor}>
        {label}
      </label>
      <div className="rw-auth-control">{children}</div>
    </div>
  )
}

interface AuthorizationPanelProps {
  authorization: AuthorizationState
  onChange: (patch: Partial<AuthorizationState>) => void
  /** Variáveis do ambiente ativo — todos os campos são interpolados no envio,
   * então ganham destaque, tooltip e sugestões de `{{variável}}`. Senha e
   * client secret ficam mascarados e nunca mostram o valor da variável. */
  environmentVariables: EnvironmentVariableDto[]
  /** Origem da autenticação efetiva quando o tipo é "herdar" (requisição salva). Sem `inheritedFrom`,
   * o painel mostra só a explicação genérica da herança. */
  inheritedFrom?: InheritedAuthenticationSource
  /** Prefixo dos ids dos campos — permite ter dois painéis na tela (ex.: editor e modal de pasta). */
  idPrefix?: string
}

export const AuthorizationPanel = memo(function AuthorizationPanel({
  authorization,
  onChange,
  environmentVariables,
  inheritedFrom,
  idPrefix = 'authorization',
}: AuthorizationPanelProps) {
  const { t } = useLanguage()
  const typeOptions: SelectOption<AuthorizationType>[] = [
    { value: 'inherit', label: t('authorization.typeInherit') },
    { value: 'none', label: t('authorization.typeNone') },
    { value: 'customHeader', label: t('authorization.typeCustomHeader') },
    { value: 'bearer', label: t('authorization.typeBearer') },
    { value: 'basic', label: t('authorization.typeBasic') },
    { value: 'digest', label: t('authorization.typeDigest') },
    { value: 'oauth2ClientCredentials', label: t('authorization.typeOAuth2ClientCredentials') },
  ]
  return (
    <div className="rw-panel rw-authorization-panel">
      <div className="rw-auth-grid">
      <AuthRow label={t('authorization.typeLabel')} htmlFor={`${idPrefix}-type`}>
        <OptionSelect
          id={`${idPrefix}-type`}
          value={authorization.type}
          options={typeOptions}
          onChange={(type) => onChange({ type })}
        />
      </AuthRow>

      {authorization.type === 'inherit' && (
        <p className="rw-auth-hint">
          {inheritedFrom === undefined
            ? t('authorization.inheritHint')
            : inheritedFrom.name === null || inheritedFrom.authentication.type === 'inherit'
              ? t('authorization.inheritedNone')
              : t('authorization.inheritedFrom', {
                  name: inheritedFrom.name,
                  type: t(TYPE_LABEL_KEYS[inheritedFrom.authentication.type]),
                })}
        </p>
      )}

      {authorization.type === 'customHeader' && (
        <>
          <AuthRow label={t('authorization.headerNameLabel')} htmlFor={`${idPrefix}-header-name`}>
            <TemplateHighlightedField
              id={`${idPrefix}-header-name`}
              fieldClassName="ui-input"
              value={authorization.headerName}
              onChange={(headerName) => onChange({ headerName })}
              variables={environmentVariables}
            />
          </AuthRow>
          <AuthRow label={t('authorization.headerValueLabel')} htmlFor={`${idPrefix}-header-value`}>
            <TemplateHighlightedField
              id={`${idPrefix}-header-value`}
              fieldClassName="ui-input"
              value={authorization.headerValue}
              onChange={(headerValue) => onChange({ headerValue })}
              variables={environmentVariables}
            />
          </AuthRow>
        </>
      )}

      {authorization.type === 'bearer' && (
        <AuthRow label={t('authorization.tokenLabel')} htmlFor={`${idPrefix}-token`}>
          <TemplateHighlightedField
            id={`${idPrefix}-token`}
            fieldClassName="ui-input"
            value={authorization.token}
            onChange={(token) => onChange({ token })}
            variables={environmentVariables}
          />
        </AuthRow>
      )}

      {(authorization.type === 'basic' || authorization.type === 'digest') && (
        <>
          <AuthRow label={t('authorization.usernameLabel')} htmlFor={`${idPrefix}-username`}>
            <TemplateHighlightedField
              id={`${idPrefix}-username`}
              fieldClassName="ui-input"
              value={authorization.username}
              onChange={(username) => onChange({ username })}
              variables={environmentVariables}
            />
          </AuthRow>
          <AuthRow label={t('authorization.passwordLabel')} htmlFor={`${idPrefix}-password`}>
            <TemplateHighlightedField
              id={`${idPrefix}-password`}
              fieldClassName="ui-input"
              value={authorization.password}
              onChange={(password) => onChange({ password })}
              variables={environmentVariables}
              masked
            />
          </AuthRow>
        </>
      )}

      {authorization.type === 'oauth2ClientCredentials' && (
        <>
          <AuthRow label={t('authorization.clientIdLabel')} htmlFor={`${idPrefix}-client-id`}>
            <TemplateHighlightedField
              id={`${idPrefix}-client-id`}
              fieldClassName="ui-input"
              value={authorization.clientId}
              onChange={(clientId) => onChange({ clientId })}
              variables={environmentVariables}
            />
          </AuthRow>
          <AuthRow label={t('authorization.clientSecretLabel')} htmlFor={`${idPrefix}-client-secret`}>
            <TemplateHighlightedField
              id={`${idPrefix}-client-secret`}
              fieldClassName="ui-input"
              value={authorization.clientSecret}
              onChange={(clientSecret) => onChange({ clientSecret })}
              variables={environmentVariables}
              masked
            />
          </AuthRow>
          <AuthRow label={t('authorization.tokenUrlLabel')} htmlFor={`${idPrefix}-token-url`}>
            <TemplateHighlightedField
              id={`${idPrefix}-token-url`}
              fieldClassName="ui-input"
              value={authorization.tokenUrl}
              onChange={(tokenUrl) => onChange({ tokenUrl })}
              variables={environmentVariables}
            />
          </AuthRow>
          <AuthRow label={t('authorization.scopeLabel')} htmlFor={`${idPrefix}-scope`}>
            <TemplateHighlightedField
              id={`${idPrefix}-scope`}
              fieldClassName="ui-input"
              value={authorization.scope}
              onChange={(scope) => onChange({ scope })}
              variables={environmentVariables}
            />
          </AuthRow>
        </>
      )}
      </div>
    </div>
  )
})
