/**
 * Model-visible chat tools over `ctx.chat`: list friends with their online
 * state, deliver one message, and read the recent thread with a friend. The
 * results ride the ordinary `tool/result` session log; a delivery failure is a
 * structured domain outcome (`delivered: false` plus the stable `ChatError`
 * code), not an `isError` throw, so the model can react to an offline friend
 * without treating the tool as broken.
 * @module @deepseek-ai/dsh-tool-chat
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ChatError } from '@deepseek-ai/dsh-chat'
import type { FriendView, PeerId } from '@deepseek-ai/dsh-chat'

export const name = 'tool-chat'
export const inject = ['tools', 'chat']

const FRIEND_ARG = {
  type: 'string',
  required: true,
  description: 'The friend\'s peer id, or their display name when it is unique.',
} as const

/**
 * Resolve one friend reference against the current friend list: an exact peer
 * id wins, then a unique exact display name.
 * @param friends - the live friend list.
 * @param friend - peer id or display name as the model supplied it.
 * @returns the friend's peer id, or undefined when nothing matches.
 */
function resolveFriend(friends: readonly FriendView[], friend: string): PeerId | undefined {
  const byId = friends.find(view => view.record.peerId === friend)
  if (byId !== undefined) return byId.record.peerId
  const byName = friends.filter(view => view.record.displayName === friend)
  return byName.length === 1 ? byName[0]?.record.peerId : undefined
}

/** Register the `chat_friends`, `chat_send`, and `chat_messages` tools. */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'chat_friends',
    description:
      'List the local user\'s chat friends with their online state and the pairing fingerprint. '
      + 'Use it before sending a message or answering questions about who the user can reach.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          friends: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                peerId: { type: 'string', required: true },
                displayName: { type: 'string', required: true },
                online: { type: 'boolean', required: true },
                fingerprint: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.friends.length === 0
          ? 'The friend list is empty.'
          : value.friends.map(friend =>
            `${friend.displayName} (${friend.online ? 'online' : 'offline'})`,
          ).join('; '),
      }],
    },
    execute() {
      const friends = ctx.chat.listFriends().map(view => ({
        peerId: view.record.peerId,
        displayName: view.record.displayName,
        online: view.online,
        fingerprint: view.record.fingerprint,
      }))
      return Promise.resolve({ friends })
    },
    presentCall: () => ({ card: 'generic', title: 'List chat friends', kind: 'other' }),
  }))

  ctx.tools.register(defineTool({
    name: 'chat_send',
    description:
      'Send a chat message from the local user to one of their friends over the local network. '
      + 'Delivery resolves when the friend acknowledges the message; an offline or unknown friend '
      + 'returns `delivered: false` with the reason instead of failing the tool.',
    parameters: {
      friend: FRIEND_ARG,
      text: {
        type: 'string',
        required: true,
        description: 'The message text to deliver, as the user wants it phrased.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          delivered: { type: 'boolean', required: true },
          reason: { type: 'string', required: true },
          peerId: { type: 'string', required: true },
          messageId: { type: 'string', required: true },
          detail: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.delivered
          ? `Delivered to peer ${value.peerId}.`
          : `Not delivered (${value.reason}): ${value.detail}`,
      }],
    },
    async execute(args) {
      const peerId = resolveFriend(ctx.chat.listFriends(), args.friend)
      if (peerId === undefined) {
        return {
          delivered: false,
          reason: 'unknown-friend',
          peerId: '',
          messageId: '',
          detail: `no friend matches ${JSON.stringify(args.friend)}; call chat_friends for the list`,
        }
      }
      try {
        const record = await ctx.chat.send(peerId, args.text)
        return {
          delivered: true,
          reason: 'delivered',
          peerId: record.peerId,
          messageId: record.messageId,
          detail: '',
        }
      } catch (error: unknown) {
        if (!(error instanceof ChatError)) throw error
        return {
          delivered: false,
          reason: error.code,
          peerId,
          messageId: '',
          detail: error.message,
        }
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Send chat message', kind: 'other', rawInput: args.text }),
  }))

  ctx.tools.register(defineTool({
    name: 'chat_messages',
    description:
      'Read the recent message thread between the local user and one friend, oldest first. '
      + 'Direction `out` is a message the user sent, `in` is one the friend sent.',
    parameters: {
      friend: FRIEND_ARG,
      limit: {
        type: 'number',
        description: 'How many of the most recent messages to return (default 50).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          messages: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                direction: { type: 'string', required: true, enum: ['in', 'out'] },
                text: { type: 'string', required: true },
                sentAt: { type: 'number', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.messages.length === 0
          ? 'No messages exchanged yet.'
          : value.messages.map(message =>
            `${message.direction === 'out' ? 'to' : 'from'} friend: ${message.text}`,
          ).join('\n'),
      }],
    },
    execute(args) {
      const peerId = resolveFriend(ctx.chat.listFriends(), args.friend)
      if (peerId === undefined) return Promise.resolve({ messages: [] })
      const messages = ctx.chat.messages(peerId, args.limit ?? 50).map(record => ({
        direction: record.direction,
        text: record.text,
        sentAt: record.sentAt,
      }))
      return Promise.resolve({ messages })
    },
    presentCall: args => ({ card: 'generic', title: 'Read chat thread', kind: 'other', rawInput: args.friend }),
  }))
}
