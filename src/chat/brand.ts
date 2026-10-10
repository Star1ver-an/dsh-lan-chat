/** Branded id types owned by the chat capability. */

import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * One chat participant's stable identity, minted per harness home and shared
 * in every discovery announcement and pairing handshake.
 */
export type PeerId = Branded<'PeerId'>

/** One delivered chat message's stable identity, minted by its sender. */
export type ChatMessageId = Branded<'ChatMessageId'>
