import type { ScriptTestResult } from '../../../bindings/execute-graphql-request'
import { useLanguage } from '../../../shared/i18n/use-language'
import { AlertIcon, CheckIcon } from '../../../shared/ui/icons'
import './script-test-list.css'

interface ScriptTestListProps {
  tests: ScriptTestResult[]
}

/** Resultados de `al.test` (spec 0072): um item por teste, falhas com a mensagem da asserção. */
export function ScriptTestList({ tests }: ScriptTestListProps) {
  const { t } = useLanguage()

  if (tests.length === 0) {
    return <p className="rw-status-message">{t('response.tests.empty')}</p>
  }

  return (
    <div className="script-tests">
      <ul className="script-tests-list">
        {tests.map((test, index) => (
          <li key={index} className={`script-test script-test--${test.passed ? 'passed' : 'failed'}`}>
            <span className="script-test-icon" aria-hidden="true">
              {test.passed ? <CheckIcon size={12} /> : <AlertIcon size={12} />}
            </span>
            <span className="script-test-text">
              <span className="script-test-name">{test.name}</span>
              <span className="rw-visually-hidden">
                {test.passed ? t('response.tests.passed') : t('response.tests.failed')}
              </span>
              {!test.passed && test.message && <span className="script-test-message">{test.message}</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
