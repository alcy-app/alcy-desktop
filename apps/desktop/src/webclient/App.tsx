import { useState } from 'react'
import { UnlockScreen } from './components/UnlockScreen'
import { Workbench } from './components/Workbench'
import { toSnapshot, type LoadedPayload } from './data'
import { t } from './i18n'

export function App({ initial }: { initial: LoadedPayload }) {
  const [payload, setPayload] = useState(initial)

  const unlock = (snapshotJson: string) => {
    try {
      setPayload(toSnapshot(JSON.parse(snapshotJson)))
    } catch {
      setPayload({ kind: 'invalid' })
    }
  }

  switch (payload.kind) {
    case 'sealed':
      return <UnlockScreen envelope={payload.envelope} onUnlocked={unlock} />
    case 'ready':
      return <Workbench snapshot={payload.snapshot} />
    case 'newerVersion':
      return <p className="wc-alert wc-alert--error wc-page-message">{t('app.unsupportedVersion')}</p>
    case 'invalid':
      return <p className="wc-alert wc-alert--error wc-page-message">{t('app.loadingFailed')}</p>
  }
}
