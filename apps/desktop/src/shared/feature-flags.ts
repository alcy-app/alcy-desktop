/**
 * Enable or disable complete interface features without removing their code.
 * Disabling a flag hides the feature and prevents automatic execution.
 */
export const FEATURE_FLAGS: Readonly<Record<'updates' | 'valueMonitors' | 'gitlab' | 'onedrive' | 'notifications' | 'webclientExport' | 'loadTesting', boolean>> = {
  /** Check for, download and install application updates. */
  updates: true,
  /**
   * GitLab integration: sidebar versioning tab, status bar indicator,
   * the visible but disabled GitLab settings category, and automatic
   * checks for the linked workspace.
   */
  gitlab: false,
  /**
   * OneDrive/SharePoint as a version control provider (ADR 0063): the
   * Microsoft accounts settings category and the OneDrive option when
   * linking a workspace. The versioning tab appears when this or `gitlab`
   * is on.
   */
  onedrive: true,
  /** Notification bell on the right side of the status bar. */
  notifications: true,
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
}
