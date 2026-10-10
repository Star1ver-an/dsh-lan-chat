import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection/types'

/** Host-only activity timestamp used to select the root agent receiving chat input. */
export interface ChatActivityProjection {
  readonly lastAt: number
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Latest event time known to the chat root-agent selector. */
    chatActivity: ChatActivityProjection
  }
}

const chatActivityStateSchema: ZodType<ChatActivityProjection> = zod.object({
  lastAt: zod.number().int().nonnegative(),
}).strict()

/**
 * Fold every committed event's time into one host-only cursor. It avoids
 * synchronous reads of arbitrary historical events while preserving the
 * boot-time choice of the most recently active root.
 */
export const chatActivityProjectionDefinition = {
  key: 'chatActivity',
  stateVersion: 0,
  stateSchema: chatActivityStateSchema,
  init: header => ({ lastAt: header.createdAt }),
  apply: (state, event) => ({ lastAt: Math.max(state.lastAt, event.time) }),
} satisfies ProjectionDefinition<'chatActivity', ChatActivityProjection>
