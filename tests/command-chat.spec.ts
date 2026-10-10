import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from './helpers/inbox.ts'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ChatError } from '@deepseek-ai/dsh-chat'
import type { ChatMessageId, ChatMessageRecord, DiscoveredPeer, FriendRecord, FriendView, PairingRequestRecord, PeerId } from '@deepseek-ai/dsh-chat'

import * as commandChat from '../src/commands/index.ts'

/**
 * Drives the REAL plugin body: mounts `dsh-command-chat` on the real command
 * registry and executes `/friend` / `/msg` lines through
 * `ctx.commands.execute` — the same boundary a UI adapter uses — with the
 * `chat` seam replaced by vi.fn-backed fakes.
 */

function friendRecord(name: string): FriendRecord {
  return {
    peerId: brandString<PeerId>(`peer-${name.toLowerCase()}`),
    displayName: name,
    pairedAt: 100,
    fingerprint: 'deadbeef',
  }
}

function friendView(name: string, online: boolean): FriendView {
  return { record: friendRecord(name), online }
}

function incomingPending(name: string): PairingRequestRecord {
  return {
    peerId: brandString<PeerId>(`peer-${name.toLowerCase()}`),
    displayName: name,
    direction: 'incoming',
    requestedAt: 200,
  }
}

function outgoingPending(name: string): PairingRequestRecord {
  return { ...incomingPending(name), direction: 'outgoing' }
}

function discoveredPeer(name: string): DiscoveredPeer {
  return {
    peerId: brandString<PeerId>(`peer-${name.toLowerCase()}`),
    displayName: name,
    transport: 'lan',
    lastSeen: 300,
  }
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
  pending: PairingRequestRecord[]
  discovered: DiscoveredPeer[]
  requestPairing: ReturnType<typeof vi.fn>
  respondPairing: ReturnType<typeof vi.fn>
  removeFriend: ReturnType<typeof vi.fn>
  renameFriend: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
}

function chatFake(): ChatFake {
  return {
    friends: [],
    pending: [],
    discovered: [],
    requestPairing: vi.fn(() => Promise.resolve()),
    respondPairing: vi.fn(() => Promise.resolve()),
    removeFriend: vi.fn(() => Promise.resolve(true)),
    renameFriend: vi.fn((_peerId: PeerId, name: string) =>
      Promise.resolve({ ...friendRecord('Old'), displayName: name })),
    send: vi.fn((peerId: PeerId, text: string) => Promise.resolve(outboundRecord(peerId, text))),
  }
}

/** Build a live idle agent over a store-owned session, as an app's spine does. */
function stubAgent(ctx: Context, id: string): Agent {
  const session = ctx.sessions.create(SessionId(id))
  const inbox = unsupportedInbox()
  let status: AgentStatus = 'idle'
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox,
    ctx: new Context(),
    get status() { return status },
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel() { status = 'idle' },
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
  ctx.agents.register(agent)
  return agent
}

async function harness(fake: ChatFake = chatFake()): Promise<{ ctx: Context; agent: Agent; fake: ChatFake; plugin: Awaited<ReturnType<Context['plugin']>> }> {
  const ctx = new Context()
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionStore)
  ctx.provide('chat', {
    listFriends: () => fake.friends,
    listPendingPairings: () => fake.pending,
    listDiscoveredPeers: () => fake.discovered,
    requestPairing: fake.requestPairing,
    respondPairing: fake.respondPairing,
    removeFriend: fake.removeFriend,
    renameFriend: fake.renameFriend,
    send: fake.send,
  } as never)
  const plugin = await ctx.plugin(commandChat)
  const agent = stubAgent(ctx, `command-chat-${Math.random()}`)
  return { ctx, agent, fake, plugin }
}

async function run(ctx: Context, agent: Agent, line: string): Promise<{ kind: string; text?: string }> {
  const settled = await ctx.commands.execute(agent, line, [], new AbortController().signal)
  if (settled === undefined) throw new Error(`command was not registered: ${line}`)
  return settled.result
}

describe('@deepseek-ai/dsh-command-chat registration', () => {
  it('registers /friend and /msg with Loader-safe exports and disposes them', async () => {
    const test = await harness()
    expect(commandChat.name).toBe('command-chat')
    expect(commandChat.inject).toEqual(['commands', 'chat'])
    expect('default' in commandChat).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(commandChat)).toBe(commandChat)

    expect(test.ctx.commands.list(test.agent)).toContainEqual({
      name: 'friend',
      description: 'list, add, accept, decline, remove, or rename chat friends',
      input: { hint: '[add|accept|decline|remove|rename] [peerId|name]' },
    })
    expect(test.ctx.commands.list(test.agent)).toContainEqual({
      name: 'msg',
      description: 'send a chat message to a friend without a model turn',
      input: { hint: '<peerId|name> <message>' },
    })
    // /friend records its rawInput (default); /msg opts out — the chat domain owns the payload.
    expect(Object.hasOwn(test.ctx.commands.find(test.agent, 'friend') ?? {}, 'recordInput')).toBe(false)
    expect(test.ctx.commands.find(test.agent, 'msg')).toMatchObject({ recordInput: false })

    await test.plugin.dispose()
    expect(test.ctx.commands.find(test.agent, 'friend')).toBeUndefined()
    expect(test.ctx.commands.find(test.agent, 'msg')).toBeUndefined()
  })
})

describe('/friend listing', () => {
  it('reports an entirely empty roster', async () => {
    const test = await harness()
    await expect(run(test.ctx, test.agent, '/friend')).resolves.toEqual({
      kind: 'success',
      text: 'No friends, pending pairings, or discovered peers yet.',
    })
  })

  it('lists friends, both pending directions, and undiscovered peers', async () => {
    const test = await harness()
    test.fake.friends = [friendView('Alice', true), friendView('Bob', false)]
    test.fake.pending = [incomingPending('Cara'), outgoingPending('Dave')]
    test.fake.discovered = [discoveredPeer('Alice'), discoveredPeer('Eve')]
    const settled = await run(test.ctx, test.agent, '/friend')
    expect(settled.kind).toBe('success')
    expect(settled.text).toBe([
      'Friends:',
      '  Alice (online) — fingerprint deadbeef',
      '  Bob (offline) — fingerprint deadbeef',
      'Pending pairings:',
      '  ⇐ from Cara — /friend accept Cara',
      '  ⇒ to Dave — /friend wait for Dave',
      'Discovered peers (not paired):',
      '  Eve — /friend add Eve',
    ].join('\n'))
  })
})

describe('/friend subcommands', () => {
  it('adds a discovered peer by case-insensitive display name', async () => {
    const test = await harness()
    test.fake.discovered = [discoveredPeer('Eve')]
    await expect(run(test.ctx, test.agent, '/friend add eve')).resolves.toEqual({
      kind: 'success',
      text: 'Pairing request sent to eve.',
    })
    expect(test.fake.requestPairing).toHaveBeenCalledTimes(1)
    expect(test.fake.requestPairing.mock.calls[0]?.[0]).toBe('peer-eve')
  })

  it('adds by exact peer id when the announced name differs', async () => {
    const test = await harness()
    test.fake.discovered = [{ ...discoveredPeer('Eve'), peerId: brandString<PeerId>('peer-uuid') }]
    await expect(run(test.ctx, test.agent, '/friend add peer-uuid')).resolves.toEqual({
      kind: 'success',
      text: 'Pairing request sent to peer-uuid.',
    })
    expect(test.fake.requestPairing.mock.calls[0]?.[0]).toBe('peer-uuid')
  })

  it('rejects an add for an unknown peer, a missing peer, and an ambiguous name', async () => {
    const test = await harness()
    test.fake.discovered = [discoveredPeer('Alex'), { ...discoveredPeer('Alex'), peerId: brandString<PeerId>('peer-alex-2') }]
    await expect(run(test.ctx, test.agent, '/friend add ghost'))
      .resolves.toEqual({ kind: 'error', text: 'No discovered peer matches "ghost".' })
    await expect(run(test.ctx, test.agent, '/friend add')).resolves.toEqual({
      kind: 'error',
      text: 'A peer is required. Usage: /friend [add <peerId|name> | accept <peerId|name> | decline <peerId|name> | remove <peerId|name> | rename <peerId|name> <new name>]',
    })
    await expect(run(test.ctx, test.agent, '/friend add Alex'))
      .resolves.toEqual({ kind: 'error', text: 'No discovered peer matches "Alex".' })
    expect(test.fake.requestPairing).not.toHaveBeenCalled()
  })

  it('surfaces a seam ChatError as command error copy', async () => {
    const test = await harness()
    test.fake.discovered = [discoveredPeer('Eve')]
    test.fake.requestPairing.mockImplementation(() => {
      throw new ChatError('already-paired', 'peer peer-eve is already a friend')
    })
    await expect(run(test.ctx, test.agent, '/friend add Eve')).resolves.toEqual({
      kind: 'error',
      text: 'peer peer-eve is already a friend',
    })
  })

  it('accepts and decline incoming requests, resolving only against them', async () => {
    const test = await harness()
    test.fake.pending = [incomingPending('Cara'), outgoingPending('Dave')]
    await expect(run(test.ctx, test.agent, '/friend accept CARA')).resolves.toEqual({
      kind: 'success',
      text: 'Pairing with CARA accepted.',
    })
    expect(test.fake.respondPairing).toHaveBeenCalledTimes(1)
    expect(test.fake.respondPairing.mock.calls[0]).toEqual(['peer-cara', true])
    await expect(run(test.ctx, test.agent, '/friend decline cara')).resolves.toEqual({
      kind: 'success',
      text: 'Pairing request from cara declined.',
    })
    expect(test.fake.respondPairing.mock.calls[1]).toEqual(['peer-cara', false])
    // An outgoing request is not decidable locally.
    await expect(run(test.ctx, test.agent, '/friend accept dave'))
      .resolves.toEqual({ kind: 'error', text: 'No incoming pairing request matches "dave".' })
    await expect(run(test.ctx, test.agent, '/friend accept'))
      .resolves.toEqual({
        kind: 'error',
        text: 'A peer is required. Usage: /friend [add <peerId|name> | accept <peerId|name> | decline <peerId|name> | remove <peerId|name> | rename <peerId|name> <new name>]',
      })
    expect(test.fake.respondPairing).toHaveBeenCalledTimes(2)
  })

  it('removes a friend, distinguishing a real removal from an already-gone record', async () => {
    const test = await harness()
    test.fake.friends = [friendView('Alice', true)]
    await expect(run(test.ctx, test.agent, '/friend remove ALICE')).resolves.toEqual({
      kind: 'success',
      text: 'Friend ALICE removed.',
    })
    expect(test.fake.removeFriend).toHaveBeenCalledWith('peer-alice')
    test.fake.removeFriend.mockImplementation(() => false)
    await expect(run(test.ctx, test.agent, '/friend remove alice')).resolves.toEqual({
      kind: 'error',
      text: 'Friend alice was already gone.',
    })
    await expect(run(test.ctx, test.agent, '/friend remove ghost'))
      .resolves.toEqual({ kind: 'error', text: 'No friend matches "ghost".' })
    await expect(run(test.ctx, test.agent, '/friend remove')).resolves.toEqual({
      kind: 'error',
      text: 'A friend is required. Usage: /friend [add <peerId|name> | accept <peerId|name> | decline <peerId|name> | remove <peerId|name> | rename <peerId|name> <new name>]',
    })
  })

  it('renames a friend locally and reports the new name', async () => {
    const test = await harness()
    test.fake.friends = [friendView('Alice', true)]
    await expect(run(test.ctx, test.agent, '/friend rename alice Alicia')).resolves.toEqual({
      kind: 'success',
      text: 'Friend renamed to Alicia.',
    })
    expect(test.fake.renameFriend).toHaveBeenCalledTimes(1)
    expect(test.fake.renameFriend.mock.calls[0]).toEqual(['peer-alice', 'Alicia'])
    await expect(run(test.ctx, test.agent, '/friend rename alice')).resolves.toEqual({
      kind: 'error',
      text: 'A friend and a new name are required. Usage: /friend [add <peerId|name> | accept <peerId|name> | decline <peerId|name> | remove <peerId|name> | rename <peerId|name> <new name>]',
    })
    await expect(run(test.ctx, test.agent, '/friend rename')).resolves.toEqual({
      kind: 'error',
      text: 'A friend and a new name are required. Usage: /friend [add <peerId|name> | accept <peerId|name> | decline <peerId|name> | remove <peerId|name> | rename <peerId|name> <new name>]',
    })
    await expect(run(test.ctx, test.agent, '/friend rename ghost X'))
      .resolves.toEqual({ kind: 'error', text: 'No friend matches "ghost".' })
  })

  it('rejects an unknown subcommand and an ambiguous friend name', async () => {
    const test = await harness()
    test.fake.friends = [friendView('Alex', true), { record: { ...friendRecord('Alex'), peerId: brandString<PeerId>('peer-alex-2') }, online: false }]
    await expect(run(test.ctx, test.agent, '/friend buddy')).resolves.toEqual({
      kind: 'error',
      text: 'Unknown /friend subcommand "buddy". Usage: /friend [add <peerId|name> | accept <peerId|name> | decline <peerId|name> | remove <peerId|name> | rename <peerId|name> <new name>]',
    })
    await expect(run(test.ctx, test.agent, '/friend remove Alex'))
      .resolves.toEqual({ kind: 'error', text: 'No friend matches "Alex".' })
  })

  it('records its rawInput on the command/run event', async () => {
    const test = await harness()
    test.fake.discovered = [discoveredPeer('Eve')]
    await run(test.ctx, test.agent, '/friend add eve')
    const commandRun = test.agent.session.snapshotEvents().find(event => event.type === 'command/run')
    // rawInput is recorded verbatim, separator whitespace included.
    expect(commandRun?.type === 'command/run' && commandRun.data.args).toBe(' add eve')
  })
})

describe('/msg command', () => {
  it('sends to a friend by case-insensitive name, preserving interior spacing', async () => {
    const test = await harness()
    test.fake.friends = [friendView('Alice', true)]
    await expect(run(test.ctx, test.agent, '/msg ALICE  two  spaces ')).resolves.toEqual({
      kind: 'success',
      text: 'Delivered to ALICE.',
    })
    expect(test.fake.send).toHaveBeenCalledTimes(1)
    expect(test.fake.send.mock.calls[0]).toEqual(['peer-alice', 'two  spaces'])
  })

  it('sends by exact peer id', async () => {
    const test = await harness()
    test.fake.friends = [{ record: { ...friendRecord('Old Name'), peerId: brandString<PeerId>('peer-uuid') }, online: true }]
    await expect(run(test.ctx, test.agent, '/msg peer-uuid hello')).resolves.toEqual({
      kind: 'success',
      text: 'Delivered to peer-uuid.',
    })
    expect(test.fake.send.mock.calls[0]).toEqual(['peer-uuid', 'hello'])
  })

  it('requires a friend and message text, and rejects an unknown friend', async () => {
    const test = await harness()
    test.fake.friends = [friendView('Alice', true)]
    await expect(run(test.ctx, test.agent, '/msg'))
      .resolves.toEqual({ kind: 'error', text: 'Usage: /msg <peerId|name> <message>' })
    await expect(run(test.ctx, test.agent, '/msg Alice   '))
      .resolves.toEqual({ kind: 'error', text: 'Usage: /msg <peerId|name> <message>' })
    await expect(run(test.ctx, test.agent, '/msg Ghost hi'))
      .resolves.toEqual({ kind: 'error', text: 'No friend matches "Ghost".' })
    await expect(run(test.ctx, test.agent, '/msg   '))
      .resolves.toEqual({ kind: 'error', text: 'Usage: /msg <peerId|name> <message>' })
    expect(test.fake.send).not.toHaveBeenCalled()
  })

  it('surfaces a ChatError from send as error copy and rethrows other failures', async () => {
    const test = await harness()
    test.fake.friends = [friendView('Alice', false)]
    test.fake.send.mockImplementation(() => {
      throw new ChatError('peer-offline', 'peer peer-alice has no known TCP endpoint')
    })
    await expect(run(test.ctx, test.agent, '/msg alice hi')).resolves.toEqual({
      kind: 'error',
      text: 'peer peer-alice has no known TCP endpoint',
    })
    test.fake.send.mockImplementation(() => {
      throw new Error('seam exploded')
    })
    await expect(run(test.ctx, test.agent, '/msg alice hi')).rejects.toThrow('seam exploded')
  })

  it('keeps the message payload out of the command/run record', async () => {
    const test = await harness()
    test.fake.friends = [friendView('Alice', true)]
    await run(test.ctx, test.agent, '/msg alice secret words')
    const commandRun = test.agent.session.snapshotEvents().find(event => event.type === 'command/run')
    expect(commandRun?.type === 'command/run' && Object.hasOwn(commandRun.data, 'args')).toBe(false)
    // The payload appears nowhere in the session log: only the chat domain holds it.
    expect(JSON.stringify(test.agent.session.snapshotEvents()).match(/secret words/gu)).toBeNull()
  })
})

