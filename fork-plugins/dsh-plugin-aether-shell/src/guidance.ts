/** Shared model-facing file-policy rules; execution and authorization remain unchanged. */

/** Real host effects and the safe response to a refused file operation. */
export const FILE_POLICY_GUIDANCE = 'Real host effects: DSH restricts writes/deletes, not reads, network or process control; sh being off is not isolation. '
  + 'A denial is final: no alternate-tool/shell or native-token retry, no escalation; the user must change policy. '

/** Working-directory default shared by fresh processes and persistent session creation. */
export const CWD_DESCRIPTION = 'Working directory; defaults to the session workspace, which also resolves relative paths.'
