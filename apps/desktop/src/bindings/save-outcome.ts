/** What a command that saves a file did. The backend opens the save dialog
 * itself and the destination never crosses the IPC (ADR 0081); `cancelled`
 * means the person closed the dialog, which is not an error. */
export type SaveOutcome = 'saved' | 'cancelled'
