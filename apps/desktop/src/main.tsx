import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './shared/ui/buttons.css'
import App from './App.tsx'
import { installButtonMousedownWorkaround } from './shared/button-mousedown-workaround'
import { installGlobalLogHandlers } from './shared/logging/logger'
import { startUsageEvents } from './shared/usage-events/track-usage'

installButtonMousedownWorkaround()
installGlobalLogHandlers()

/**
 * Suprime o menu de contexto nativo da WebView (com itens como "Recarregar"
 * ou "Inspecionar") em todo o app, para não parecer uma página web comum.
 * Onde faz sentido um menu de botão direito (pastas, coleções, abas), os
 * próprios componentes implementam um menu customizado.
 */
document.addEventListener('contextmenu', (event) => {
  event.preventDefault()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

void startUsageEvents()
