/** Error vocabulary of the chat capability: one {@link ChatError} code per caller-actionable failure. */

/** Caller-actionable chat failure identities; the Remote layer maps each to one `chat/<code>` wire code. */
export type ChatErrorCode =
  | 'transport-unavailable'
  | 'peer-unknown'
  | 'peer-offline'
  | 'not-paired'
  | 'already-paired'
  | 'pairing-pending'
  | 'pairing-unknown'
  | 'invalid-name'
  | 'invalid-message'
  | 'message-too-long'
  | 'closed'

/**
 * One chat failure. Codes are stable caller-facing identities: commands, tools,
 * and the Remote controller branch on them, and the controller forwards each as
 * the matching `chat/<code>` `RemoteError`.
 */
export class ChatError extends Error {
  constructor(
    /** Stable failure identity. */
    readonly code: ChatErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ChatError'
  }
}
