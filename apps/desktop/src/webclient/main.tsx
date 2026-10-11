import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles/tokens.css'
import './webclient.css'
import { App } from './App'
import { DATA_ELEMENT_ID, readPayload, type LoadedPayload } from './data'
import { DEV_SAMPLE } from './dev-sample'

const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches
document.documentElement.dataset.theme = dark ? 'dark' : 'light'
document.documentElement.style.colorScheme = dark ? 'dark' : 'light'

let initial: LoadedPayload = readPayload(document.getElementById(DATA_ELEMENT_ID)?.textContent)
if (import.meta.env.DEV && initial.kind === 'invalid') initial = { kind: 'ready', snapshot: DEV_SAMPLE }

const container = document.getElementById('root')
if (container) {
  createRoot(container).render(
    <StrictMode>
      <App initial={initial} />
    </StrictMode>,
  )
}
