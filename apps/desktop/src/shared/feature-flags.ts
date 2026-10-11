/**
 * Liga/desliga funcionalidades inteiras na interface sem remover o código.
 * Desligar uma flag esconde a funcionalidade e impede que ela rode sozinha.
 */
export const FEATURE_FLAGS: Readonly<Record<'updates' | 'valueMonitors' | 'gitlab' | 'notifications' | 'webclientExport' | 'loadTesting', boolean>> = {
  /** Verificação, download e instalação de novas versões do app. */
  updates: true,
  /**
   * Integração com o GitLab: aba de versionamento da barra lateral, indicador
   * na barra de status, categoria "GitLab" das configurações (visível, mas
   * desabilitada) e verificação automática do workspace vinculado.
   */
  gitlab: false,
  /** Sino de notificações no canto direito da barra de status. */
  notifications: true,
  /** Monitor de valores: item "Monitores" da barra lateral, botão "Monitor" e destaques na resposta. */
  valueMonitors: true,
  /**
   * Exportar coleção/pasta como webclient (spec 0113): submenu "Exportar" com
   * "Formato Alcy" e "Como webclient", e o diálogo de exportação. Desligada,
   * "Exportar" volta a exportar direto no formato Alcy, só em coleções.
   */
  webclientExport: true,
  /**
   * Criação, importação e execução visual de testes de carga. O runtime
   * continua isolado no Rust, mas a interface permanece indisponível até o
   * fechamento dos blocos e do lifecycle restantes.
   */
  loadTesting: false,
}
