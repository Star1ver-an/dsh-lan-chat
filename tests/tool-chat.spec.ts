import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ChatError } from '@deepseek-ai/dsh-chat'
import type { ChatMessageId, ChatMessageRecord, FriendRecord, FriendView, PeerId } from '@deepseek-ai/dsh-chat'

import * as tool from '../src/tools/index.ts'

const testToolSignal = new AbortController().signal

/**
 * Drives the REAL plugin body: mounts `dsh-tool-chat` on a real `ToolRuntime`
 * and invokes the registered tools through `ctx.tools.execute`, with the
 * `chat` seam replaced by an in-memory fake — the tool is the shipping code,
 * the runtime service is the stand-in.
 */

function friendView(name: string, online: boolean): FriendView {
  const record: FriendRecord = {
    peerId: brandString<PeerId>(`peer-${name.toLowerCase()}`),
    displayName: name,
    pairedAt: 100,
    fingerprint: 'deadbeef',
  }
  return { record, online }
}

function outboundRecord(peerId: PeerId, text: string): ChatMessageRecord {
  return {
    messageId: brandString<ChatMessageId>('msg-1'),
    peerId,
    direction: 'out',
    text,
    sentAt: 500,
    deliveredAt: 501,
  }
}

interface ChatFake {
  friends: FriendView[]
  sentTo: { peerId: PeerId; text: string }[]
  threads: ChatMessageRecord[]
  sendError: Error | undefined
}

function chatFake(): ChatFake {
  return { friends: [], sentTo: [], threads: [], sendError: undefined }
}

/** Install the fake `chat` seam so the plugin's `inject` resolves. */
function provideChat(ctx: Context, fake: ChatFake): void {
  ctx.provide('chat', {
    listFriends: () => fake.friends,
    send: (peerId: PeerId, text: string) => {
      if (fake.sendError !== undefined) return Promise.reject(fake.sendError)
      fake.sentTo.push({ peerId, text })
      return Promise.resolve(outboundRecord(peerId, text))
    },
    messages: (peerId: PeerId, limit?: number) =>
      fake.threads.filter(record => record.peerId === peerId).slice(-(limit ?? 50)),
  } as never)
}

/** Mount the plugin over a fake `chat` seam. */
async function setup(fake: ChatFake): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  provideChat(ctx, fake)
  await ctx.plugin(tool)
  return ctx
}

let callCounter = 0
function call(ctx: Context, name: string, args: unknown) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(`call-${++callCounter}`),
    name,
    arguments: args,
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

describe('@deepseek-ai/dsh-tool-chat registration', () => {
  it('registers the three chat tools with Loader-safe exports', async () => {
    const ctx = await setup(chatFake())
    expect(tool.name).toBe('tool-chat')
    expect(tool.inject).toEqual(['tools', 'chat'])
    expect('default' in tool).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(tool)).toBe(tool)
    expect(typeof tool.apply).toBe('function')

    const names = ctx.tools.schemas().map(s => s.name)
    expect(names).toContain('chat_friends')
    expect(names).toContain('chat_send')
    expect(names).toContain('chat_messages')
  })

  it('unregisters the tools when its contributing fiber is disposed (HMR-safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SessionProjectionRegistry)
    provideChat(ctx, chatFake())
    const fiber = await ctx.plugin(tool)
    expect(ctx.tools.schemas().some(s => s.name === 'chat_send')).toBe(true)
    await fiber.dispose()
    expect(ctx.tools.schemas().some(s => s.name === 'chat_send')).toBe(false)
  })

  it('rejects a chat_send missing its required text before execute runs', async () => {
    const ctx = await setup(chatFake())
    const result = await call(ctx, 'chat_send', { friend: 'Alice' })
    expect(result.isError).toBe(true)
  })
})

describe('chat_friends tool', () => {
  it('reports an empty friend list', async () => {
    const ctx = await setup(chatFake())
    const result = await call(ctx, 'chat_friends', {})
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected chat_friends success')
    expect(result.value).toEqual({ friends: [] })
    expect(text(result)).toBe('The friend list is empty.')
  })

  it('lists each friend with online state and fingerprint', async () => {
    const fake = chatFake()
    fake.friends = [friendView('Alice', true), friendView('Bob', false)]
    const ctx = await setup(fake)
    const result = await call(ctx, 'chat_friends', {})
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected chat_friends success')
    expect(result.value).toEqual({
      friends: [
        { peerId: 'peer-alice', displayName: 'Alice', online: true, fingerprint: 'deadbeef' },
        { peerId: 'peer-bob', displayName: 'Bob', online: false, fingerprint: 'deadbeef' },
      ],
    })
    expect(text(result)).toBe('Alice (online); Bob (offline)')
  })

  it('presents the call with a stable title', async () => {
    const ctx = await setup(chatFake())
    expect(ctx.tools.get('chat_friends')?.presentCall?.({})).toEqual({
      card: 'generic', title: 'List chat friends', kind: 'other',
    })
  })
})

describe('chat_send tool', () => {
  it('resolves a unique display name and delivers to its peer id', async () => {
    const fake = chatFake()
    fake.friends = [friendView('Alice', true)]
    const ctx = await setup(fake)
    const result = await call(ctx, 'chat_send', { friend: 'Alice', text: 'lunch at noon?' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected chat_send success')
    expect(fake.sentTo).toEqual([{ peerId: 'peer-alice', text: 'lunch at noon?' }])
    expect(result.value).toEqual({
      delivered: true,
      reason: 'delivered',
      peerId: 'peer-alice',
      messageId: 'msg-1',
      detail: '',
    })
    expect(text(result)).toBe('Delivered to peer peer-alice.')
  })

  it('prefers an exact peer id over any display-name match', async () => {
    const fake = chatFake()
    fake.friends = [friendView('Renamed', true)]
    const ctx = await setup(fake)
    const result = await call(ctx, 'chat_send', { friend: 'peer-renamed', text: 'still you' })
    expect(result.isError).toBe(false)
    expect(fake.sentTo).toEqual([{ peerId: 'peer-renamed', text: 'still you' }])
  })

  it('reports an unknown friend as a structured non-delivery', async () => {
    const ctx = await setup(chatFake())
    const result = await call(ctx, 'chat_send', { friend: 'Ghost', text: 'anyone there?' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected structured non-delivery')
    expect(result.value).toEqual({
      delivered: false,
      reason: 'unknown-friend',
      peerId: '',
      messageId: '',
      detail: 'no friend matches "Ghost"; call chat_friends for the list',
    })
    expect(text(result)).toBe('Not delivered (unknown-friend): no friend matches "Ghost"; call chat_friends for the list')
  })

  it('treats display-name matching as exact, not case-insensitive', async () => {
    const fake = chatFake()
    fake.friends = [friendView('Alice', true)]
    const ctx = await setup(fake)
    const result = await call(ctx, 'chat_send', { friend: 'alice', text: 'lowercase' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected structured non-delivery')
    expect(result.value).toMatchObject({ delivered: false, reason: 'unknown-friend' })
    expect(fake.sentTo).toEqual([])
  })

  it('reports an ambiguous display name as unknown', async () => {
    const fake = chatFake()
    fake.friends = [friendView('Alex', true), friendView('Alex', false)]
    const ctx = await setup(fake)
    const result = await call(ctx, 'chat_send', { friend: 'Alex', text: 'which one?' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected structured non-delivery')
    expect(result.value).toMatchObject({ delivered: false, reason: 'unknown-friend' })
  })

  it('maps a ChatError from the seam to a structured non-delivery with its code', async () => {
    const fake = chatFake()
    fake.friends = [friendView('Alice', false)]
    fake.sendError = new ChatError('peer-offline', 'peer peer-alice has no known TCP endpoint')
    const ctx = await setup(fake)
    const result = await call(ctx, 'chat_send', { friend: 'Alice', text: 'hello?' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected structured non-delivery')
    expect(result.value).toEqual({
      delivered: false,
      reason: 'peer-offline',
      peerId: 'peer-alice',
      messageId: '',
      detail: 'peer peer-alice has no known TCP endpoint',
    })
    expect(text(result)).toBe('Not delivered (peer-offline): peer peer-alice has no known TCP endpoint')
  })

  it('surfaces a non-chat failure as an error tool result', async () => {
    const fake = chatFake()
    fake.friends = [friendView('Alice', true)]
    fake.sendError = new Error('seam exploded')
    const ctx = await setup(fake)
    const result = await call(ctx, 'chat_send', { friend: 'Alice', text: 'boom' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('seam exploded')
  })

  it('presents the call with the message text as raw input', async () => {
    const ctx = await setup(chatFake())
    expect(ctx.tools.get('chat_send')?.presentCall?.({ friend: 'Alice', text: 'hi' })).toEqual({
      card: 'generic', title: 'Send chat message', kind: 'other', rawInput: 'hi',
    })
  })
})

describe('chat_messages tool', () => {
  it('returns an empty thread for an unknown friend', async () => {
    const ctx = await setup(chatFake())
    const result = await call(ctx, 'chat_messages', { friend: 'Ghost' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected chat_messages success')
    expect(result.value).toEqual({ messages: [] })
    expect(text(result)).toBe('No messages exchanged yet.')
  })

  it('returns the most recent window and renders both directions', async () => {
    const fake = chatFake()
    const alice = brandString<PeerId>('peer-alice')
    fake.friends = [friendView('Alice', true)]
    fake.threads = [
      { messageId: brandString<ChatMessageId>('m1'), peerId: alice, direction: 'out', text: 'first', sentAt: 10, deliveredAt: 11 },
      { messageId: brandString<ChatMessageId>('m2'), peerId: alice, direction: 'in', text: 'hi!', sentAt: 20, deliveredAt: 21 },
      { messageId: brandString<ChatMessageId>('m3'), peerId: alice, direction: 'out', text: 'welcome', sentAt: 30, deliveredAt: 31 },
    ]
    const ctx = await setup(fake)
    const result = await call(ctx, 'chat_messages', { friend: 'Alice', limit: 2 })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected chat_messages success')
    expect(result.value).toEqual({
      messages: [
        { direction: 'in', text: 'hi!', sentAt: 20 },
        { direction: 'out', text: 'welcome', sentAt: 30 },
      ],
    })
    expect(text(result)).toBe('from friend: hi!\nto friend: welcome')
  })

  it('defaults the limit to 50 when the argument is absent', async () => {
    const fake = chatFake()
    const alice = brandString<PeerId>('peer-alice')
    fake.friends = [friendView('Alice', true)]
    for (let index = 0; index < 60; index += 1) {
      fake.threads.push({
        messageId: brandString<ChatMessageId>(`m${index}`),
        peerId: alice,
        direction: 'out',
        text: `message ${index}`,
        sentAt: index,
        deliveredAt: index,
      })
    }
    const ctx = await setup(fake)
    const result = await call(ctx, 'chat_messages', { friend: 'Alice' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected chat_messages success')
    const value = result.value as { messages: { direction: string; text: string; sentAt: number }[] }
    expect(value.messages).toHaveLength(50)
    expect(value.messages[0]).toEqual({ direction: 'out', text: 'message 10', sentAt: 10 })
  })

  it('presents the call with the friend reference as raw input', async () => {
    const ctx = await setup(chatFake())
    expect(ctx.tools.get('chat_messages')?.presentCall?.({ friend: 'Alice' })).toEqual({
      card: 'generic', title: 'Read chat thread', kind: 'other', rawInput: 'Alice',
    })
  })
})
