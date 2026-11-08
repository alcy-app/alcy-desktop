/**
 * Enable or disable complete interface features without removing their code.
 * Disabling a flag hides the feature and prevents automatic execution.
 */
export const FEATURE_FLAGS: Readonly<Record<'updates' | 'valueMonitors' | 'localGit' | 'notifications' | 'webclientExport' | 'loadTesting' | 'agent' | 'usageEvents' | 'documents', boolean>> = {
  /** Check for, download and install application updates. */
  updates: true,
  /**
   * Git in the workspace folder (ADR 0074): "Start git in the workspace",
   * branches, merges, history, the `origin` remote (fetch, pull, push),
   * importing a workspace from a repository and the Git settings category
   * (commit author). Remotes run the git installed on the computer.
   */
  localGit: true,
  /** Notification bell on the right side of the status bar. */
  notifications: false,
  /** Value monitors: sidebar entry, Monitor button and response highlights. */
  valueMonitors: true,
  /**
   * Collection/folder webclient export (spec 0113): format selection in the
   * Export submenu and its dialog. When disabled, collections export directly
   * in Alcy format and folders have no export action.
   */
  webclientExport: true,
  /**
   * Visual creation, import and execution of load tests.
   * The runtime remains isolated in Rust.
   */
  loadTesting: true,
  /**
   * Agent chat panel (ADR 0064): the panel, its status bar button, its
   * shortcut and the Agent settings category. Nothing is sent to
   * a provider until the user configures one.
   */
  agent: true,
  /**
   * Usage events (spec 0142): the interface activates the native hub at
   * startup and reports shortcut, environment, settings and sidebar events.
   * Inert unless an extension registers a sink: this build has none, so
   * nothing is recorded or sent. Off disables usage events in every build.
   */
  usageEvents: true,
  /**
   * Workspace documents (specs 0144 and 0145): the Documents sidebar module,
   * its editor tabs and PDF/Markdown export, and the agent's document tools
   * and documentation guidance. Off: nothing is loaded and the chat cannot
   * create or edit documents.
   */
  documents: false,
}
