import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { hostname } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { DomainChanged, DomainSpec } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { pairingFingerprint } from '../src/chat/fingerprint.ts'
import { ChatError } from '../src/chat/error.ts'
import ChatRuntime from '../src/chat/index.ts'
import type {
  ChatConfig,
  ChatMessageRecord,
  ChatTransportHost,
  FriendRecord,
  InboundChatMessage,
} from '../src/chat/index.ts'
import type { ChatMessageId, PeerId } from '../src/chat/brand.ts'

const peer = (value: string): PeerId => brandString<PeerId>(value)
const mid = (value: string): ChatMessageId => brandString<ChatMessageId>(value)

/** Sender-minted inbound message as the wire would carry it. */
const message = (messageId: string, text: string, sentAt = 1): InboundChatMessage =>
  ({ messageId: mid(messageId), text, sentAt })

/** Test double transport: records every runtime call, delivery under test control. */
class FakeTransport {
  readonly name = 'fake'
  started = 0
  stopped = 0
  startError: Error | undefined
  deliverError: ChatError | undefined
  readonly reachable = new Set<PeerId>()
  readonly pairingRequests: PeerId[] = []
  readonly pairingResponses: { peerId: PeerId; accept: boolean }[] = []
  readonly pendingDeliveries: {
    peerId: PeerId
    message: InboundChatMessage
    resolve: () => void
    reject: (cause: unknown) => void
  }[] = []

  start = async (): Promise<void> => {
    this.started += 1
    if (this.startError !== undefined) throw this.startError
  }

  stop = async (): Promise<void> => {
    this.stopped += 1
  }

  deliver = async (peerId: PeerId, message: InboundChatMessage): Promise<void> => {
    if (this.deliverError !== undefined) throw this.deliverError
    return new Promise((resolve, reject) => {
      this.pendingDeliveries.push({ peerId, message, resolve, reject })
    })
  }

  transmitPairingRequest = async (peerId: PeerId): Promise<void> => {
    this.pairingRequests.push(peerId)
  }

  transmitPairingResponse = async (peerId: PeerId, accept: boolean): Promise<void> => {
    this.pairingResponses.push({ peerId, accept })
  }

  isReachable = (peerId: PeerId): boolean => this.reachable.has(peerId)
}

/** The peer id of one harness's home. */
function idOf(h: Harness): PeerId {
  return h.chat.identity.peerId
}

interface Harness {
  readonly ctx: Context
  readonly chat: ChatRuntime
  readonly pool: MemoryMediaPool
  readonly transport: FakeTransport
  readonly changes: DomainChanged[]
  /** Replace the root-agent set the runtime injects into. */
  readonly setRoots: (...agents: Agent[]) => void
  readonly dispose: () => Promise<void>
}

/** Controlled projection values backing the fake sessionProjections registry. */
const fakeActivity = new WeakMap<Agent, number>()

interface RawContext {
  readonly ctx: Context
  readonly pool: MemoryMediaPool
  /** Mount ChatRuntime on the prepared storage; no transport registered yet. */
  mountChat(config?: ChatConfig): Promise<ChatRuntime>
  /** Replace the root-agent set the runtime injects into. */
  readonly setRoots: (...agents: Agent[]) => void
  readonly dispose: () => Promise<void>
}

/** Storage + an empty mutable agent registry, without ChatRuntime — for custom mount sequences. */
async function rawContext(pool = new MemoryMediaPool()): Promise<RawContext> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const roots: Agent[] = []
  ctx.provide('agents', { roots: () => roots } as never)
  ctx.provide('sessionProjections', {
    register: () => () => {},
    stateOf: (session: Agent, key: 'chatActivity') => key === 'chatActivity' ? fakeActivity.get(session) : undefined,
  } as never)
  return {
    ctx,
    pool,
    mountChat: async (config: ChatConfig = {}) => {
      await ctx.plugin(ChatRuntime, config)
      return ctx.chat
    },
    setRoots: (...agents: Agent[]) => {
      roots.splice(0, roots.length, ...agents)
    },
    dispose: () => ctx.fiber.dispose(),
  }
}

/** Full harness: chat runtime mounted with one fake transport registered. */
async function harness(config: ChatConfig = {}, pool = new MemoryMediaPool()): Promise<Harness> {
  const raw = await rawContext(pool)
  try {
    const chat = await raw.mountChat(config)
    const transport = new FakeTransport()
    await chat.registerTransport(transport)
    const changes: DomainChanged[] = []
    raw.ctx.on('domain/changed', (change) => { changes.push(change) })
    return {
      ctx: raw.ctx,
      chat,
      pool,
      transport,
      changes,
      setRoots: raw.setRoots,
      dispose: raw.dispose,
    }
  } catch (error) {
    await raw.dispose()
    throw error
  }
}

interface FakeAgent {
  readonly agent: Agent
  readonly inject: Mock<(message: UserMessage) => void>
}

/** Minimal Agent double; `activeAt === undefined` models an empty log (header creation time is the floor). */
function fakeAgent(activeAt: number | undefined, createdAt = 0): FakeAgent {
  const inject = vi.fn<(message: UserMessage) => void>()
  const agent = {
    inject,
    session: {
      seq: activeAt === undefined ? 0 : 1,
      header: { createdAt },
    },
  } as never as Agent
  fakeActivity.set(agent, activeAt ?? createdAt)
  return { agent, inject }
}

/** The one message the agent received; throws when the agent was never injected into. */
function injectedMessage(agent: FakeAgent): UserMessage {
  const call = agent.inject.mock.calls.at(0)
  if (call === undefined) throw new Error('expected the agent to receive one injection')
  return call[0]
}

/** The only friend record of a harness; throws when the friend set is not exactly one. */
function onlyFriend(h: Harness): FriendRecord {
  const [friend] = h.chat.listFriends()
  if (friend === undefined) throw new Error('expected exactly one friend')
  return friend.record
}

/** The reachability belief of a harness's only friend; throws when the set is not exactly one. */
function onlyOnline(h: Harness): boolean {
  const [friend] = h.chat.listFriends()
  if (friend === undefined) throw new Error('expected exactly one friend')
  return friend.online
}

/** Drive A's pairing request across the fake transports into B's host. */
async function requestAcross(a: Harness, b: Harness): Promise<void> {
  a.chat.host.onPeerDiscovered({ peerId: idOf(b), displayName: b.chat.identity.displayName })
  await a.chat.requestPairing(idOf(b))
  b.chat.host.onPairingRequest({ peerId: idOf(a), displayName: a.chat.identity.displayName })
}

/** Drive B's acceptance back into A's host and wait for A's durable record. */
async function acceptAcross(b: Harness, a: Harness): Promise<void> {
  await b.chat.respondPairing(idOf(a), true)
  a.chat.host.onPairingResponse(idOf(b), true)
  await paired(a, idOf(b))
}

/** Resolve once the runtime stored the friend record (immediate when present). */
function paired(h: Harness, peerId: PeerId): Promise<void> {
  if (h.chat.listFriends().some(entry => entry.record.peerId === peerId)) return Promise.resolve()
  return new Promise((resolve) => {
    h.ctx.on('chat/friend-changed', (change) => {
      if (change.peerId === peerId && change.operation === 'added') resolve()
    })
  })
}

/** Send across the pair: hold the outbound delivery, land it in the receiver's host, ack it. */
async function sendAcross(sender: Harness, receiver: Harness, text: string): Promise<ChatMessageRecord> {
  const sending = sender.chat.send(idOf(receiver), text)
  await vi.waitFor(() => { expect(sender.transport.pendingDeliveries).toHaveLength(1) })
  const pending = sender.transport.pendingDeliveries.shift()
  if (pending === undefined) throw new Error('test bug: the outbound delivery vanished')
  const accepted = await receiver.chat.host.onMessage(idOf(sender), pending.message)
  expect(accepted).toBe(true)
  pending.resolve()
  return sending
}

/** Establish a mutual friendship between two harnesses. */
async function pair(a: Harness, b: Harness): Promise<void> {
  await requestAcross(a, b)
  await acceptAcross(b, a)
}

/** A manually resolved gate for parking async work under test. */
function createGate(): { readonly promise: Promise<void>; open(): void } {
  let release = (): void => {}
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, open: () => { release() } }
}

const harnesses: Harness[] = []
const disposables: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(disposables.splice(0).map(dispose => dispose()))
  harnesses.length = 0
})

describe('fingerprint', () => {
  it('derives the same value for both orderings of one pair and a different value for another pair', () => {
    expect(pairingFingerprint('aa', 'bb')).toBe(pairingFingerprint('bb', 'aa'))
    expect(pairingFingerprint('aa', 'bb')).not.toBe(pairingFingerprint('aa', 'cc'))
    expect(pairingFingerprint('aa', 'bb')).toMatch(/^[0-9a-f]{8}$/)
  })
})

describe('identity', () => {
  it('mints a stable identity with the hostname-derived default display name', async () => {
    const h = await harness()
    harnesses.push(h)
    const identity = h.chat.identity
    expect(identity.peerId).toMatch(/^[0-9a-f-]{36}$/)
    expect(identity.displayName).toBe(`${hostname()}-${identity.peerId.slice(0, 4)}`)
  })

  it('honors a config display name and re-applies the override over a stored name on boot', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness({ displayName: 'Alpha' }, pool)
    expect(first.chat.identity.displayName).toBe('Alpha')
    await first.dispose()

    // A later boot without the override keeps the stored name...
    const second = await harness({}, pool)
    harnesses.push(second)
    expect(second.chat.identity.displayName).toBe('Alpha')
    await second.dispose()

    // ...and a later boot with a new override rewrites it.
    const third = await harness({ displayName: 'Gamma' }, pool)
    harnesses.push(third)
    expect(third.chat.identity.displayName).toBe('Gamma')
  })

  it('persists setDisplayName and rejects invalid names', async () => {
    const h = await harness()
    harnesses.push(h)
    const { pool } = h
    await h.chat.setDisplayName('  Renamed  ')
    expect(h.chat.identity.displayName).toBe('Renamed')
    await h.dispose()

    const reopened = await harness({}, pool)
    harnesses.push(reopened)
    expect(reopened.chat.identity.displayName).toBe('Renamed')

    await expect(reopened.chat.setDisplayName('   ')).rejects.toMatchObject({ code: 'invalid-name' })
    await expect(reopened.chat.setDisplayName('x'.repeat(65))).rejects.toMatchObject({ code: 'invalid-name' })
  })

  it('fails loud on service reads while the async mount is still in flight', async () => {
    const ctx = new Context()
    disposables.push(() => ctx.fiber.dispose())
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend())
    const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', facility)
    // Hold the domain open behind a gate so the runtime constructor has
    // registered ctx.chat while its async [Service.init] is still in flight.
    const gate = createGate()
    ctx.provide('storageDomain', {
      open: async <S extends DomainSpec>(spec: S) => {
        await gate.promise
        return facility.open(spec)
      },
    } as never)
    ctx.provide('agents', { roots: () => [] } as never)
    ctx.provide('sessionProjections', { register: () => () => {}, stateOf: () => undefined } as never)
    const fiber = ctx.plugin(ChatRuntime, {})
    await vi.waitFor(() => { expect(ctx.chat).toBeDefined() })
    // Every service surface refuses loud while the async mount is in flight.
    expect(() => ctx.chat.identity).toThrow('not initialized')
    expect(() => ctx.chat.listFriends()).toThrow('not initialized')
    expect(() => ctx.chat.messages(peer('x'))).toThrow('not initialized')
    await expect(ctx.chat.setDisplayName('x')).rejects.toThrow('not initialized')
    gate.open()
    await fiber
  })

  it('applies config fallbacks when constructed raw', () => {
    const raw = new ChatRuntime(new Context(), {})
    expect(raw).toBeDefined()
  })
})

describe('transport registration', () => {
  it('rejects a second registration while the first start is in flight and after it lands', async () => {
    const raw = await rawContext()
    disposables.push(raw.dispose)
    const chat = await raw.mountChat()
    const gate = createGate()
    const slow = new FakeTransport()
    slow.start = () => gate.promise
    const first = chat.registerTransport(slow)
    await expect(chat.registerTransport(new FakeTransport())).rejects.toThrow('already registered')
    gate.open()
    await first
    await expect(chat.registerTransport(new FakeTransport())).rejects.toThrow('already registered')
  })

  it('frees the slot again when a transport start rejects', async () => {
    const raw = await rawContext()
    disposables.push(raw.dispose)
    const chat = await raw.mountChat()
    const broken = new FakeTransport()
    broken.startError = new Error('bind failed')
    await expect(chat.registerTransport(broken)).rejects.toThrow('bind failed')
    const working = new FakeTransport()
    await chat.registerTransport(working)
    expect(working.started).toBe(1)
  })

  it('stops the registered transport on teardown', async () => {
    const h = await harness()
    await h.dispose()
    expect(h.transport.stopped).toBe(1)
  })

  it('warns and still closes the domain when the transport stop fails during teardown', async () => {
    const h = await harness()
    h.transport.stop = async () => {
      throw new Error('socket already gone')
    }
    await expect(h.dispose()).resolves.toBeUndefined()
  })

  it('tears down cleanly without a registered transport', async () => {
    const raw = await rawContext()
    const chat = await raw.mountChat()
    expect(chat.listDiscoveredPeers()).toEqual([])
    await raw.dispose()
  })
})

describe('pairing', () => {
  it('records an outgoing request, emits it, and rejects duplicates', async () => {
    const h = await harness({ displayName: 'Home' })
    const other = await harness()
    harnesses.push(h, other)
    const events: unknown[] = []
    h.ctx.on('chat/pairing', (payload) => { events.push(payload) })

    h.chat.host.onPeerDiscovered({ peerId: idOf(other), displayName: other.chat.identity.displayName })
    await h.chat.requestPairing(idOf(other))
    other.chat.host.onPairingRequest({ peerId: idOf(h), displayName: 'Home' })
    expect(h.transport.pairingRequests).toEqual([idOf(other)])
    expect(h.chat.listPendingPairings()).toMatchObject([{ peerId: idOf(other), direction: 'outgoing' }])
    expect(events).toEqual([{
      peerId: idOf(other),
      displayName: other.chat.identity.displayName,
      direction: 'outgoing',
      operation: 'requested',
    }])

    await expect(h.chat.requestPairing(idOf(other))).rejects.toMatchObject({ code: 'pairing-pending' })
    await acceptAcross(other, h)
    await expect(h.chat.requestPairing(idOf(other))).rejects.toMatchObject({ code: 'already-paired' })
  })

  it('falls back to the peer id as the pending display name for undiscovered peers', async () => {
    const h = await harness()
    harnesses.push(h)
    await h.chat.requestPairing(peer('ghost'))
    expect(h.chat.listPendingPairings()).toMatchObject([{ peerId: peer('ghost'), displayName: peer('ghost') }])
  })

  it('drops the pending request when the transport cannot reach the peer', async () => {
    const h = await harness()
    harnesses.push(h)
    h.transport.transmitPairingRequest = async () => {
      throw new ChatError('peer-offline', 'peer went away')
    }
    await expect(h.chat.requestPairing(peer('far'))).rejects.toMatchObject({ code: 'peer-offline' })
    expect(h.chat.listPendingPairings()).toEqual([])
  })

  it('pends an incoming request for a human decision, then accepts with the pair fingerprint', async () => {
    const a = await harness({ displayName: 'A' })
    const b = await harness({ displayName: 'B' })
    harnesses.push(a, b)
    const events: unknown[] = []
    b.ctx.on('chat/pairing', (payload) => { events.push(payload) })

    await requestAcross(a, b)
    expect(b.chat.listPendingPairings()).toMatchObject([{
      peerId: idOf(a),
      displayName: 'A',
      direction: 'incoming',
    }])
    expect(events).toEqual([{ peerId: idOf(a), displayName: 'A', direction: 'incoming', operation: 'requested' }])

    await acceptAcross(b, a)
    expect(events.at(-1)).toMatchObject({ direction: 'incoming', operation: 'accepted' })
    const friend = b.chat.listFriends().find(entry => entry.record.peerId === idOf(a))
    expect(friend?.record.displayName).toBe('A')
    expect(friend?.record.fingerprint).toBe(pairingFingerprint(idOf(a), idOf(b)))
    expect(b.transport.pairingResponses).toEqual([{ peerId: idOf(a), accept: true }])

    // The requester side learned the acceptance through its host callback.
    expect(a.chat.listFriends().map(entry => entry.record.fingerprint)).toEqual([friend?.record.fingerprint])

    // Answering with no pending request is a caller error...
    await expect(b.chat.respondPairing(idOf(a), true)).rejects.toMatchObject({ code: 'pairing-unknown' })
    // ...while an unsolicited host-level answer warns and is dropped.
    expect(() => { b.chat.host.onPairingResponse(idOf(a), true) }).not.toThrow()
  })

  it('declines an incoming request without storing a friend', async () => {
    const a = await harness({ displayName: 'A' })
    const b = await harness({ displayName: 'B' })
    harnesses.push(a, b)
    const events: unknown[] = []
    b.ctx.on('chat/pairing', (payload) => { events.push(payload) })

    await requestAcross(a, b)
    await b.chat.respondPairing(idOf(a), false)
    expect(b.chat.listFriends()).toEqual([])
    expect(b.transport.pairingResponses).toEqual([{ peerId: idOf(a), accept: false }])
    expect(events.at(-1)).toMatchObject({ direction: 'incoming', operation: 'declined' })

    // The requester learns of the decline through its host callback.
    a.chat.host.onPairingResponse(idOf(b), false)
    expect(a.chat.listPendingPairings()).toEqual([])
    expect(a.chat.listFriends()).toEqual([])
  })

  it('warns instead of crashing when storing an accepted pairing fails', async () => {
    const a = await harness({ displayName: 'A' })
    const b = await harness({ displayName: 'B' })
    harnesses.push(a, b)
    await requestAcross(a, b)

    // The accept answer arrives, but durability of the friend record fails.
    a.pool.failNextWrites = 1
    a.chat.host.onPairingResponse(idOf(b), true)
    await vi.waitFor(() => { expect(a.pool.failNextWrites).toBe(0) })
    expect(a.chat.listFriends()).toEqual([])
    expect(a.chat.listPendingPairings()).toEqual([])

    // The peer can re-request and the pairing completes normally.
    await a.chat.requestPairing(idOf(b))
    b.chat.host.onPairingRequest({ peerId: idOf(a), displayName: 'A' })
    a.chat.host.onPairingResponse(idOf(b), true)
    await paired(a, idOf(b))
    expect(a.chat.listFriends()).toHaveLength(1)
  })

  it('responds to a request from an already-accepted friend without recreating the record', async () => {
    const a = await harness({ displayName: 'A' })
    const b = await harness({ displayName: 'B' })
    harnesses.push(a, b)
    await pair(a, b)
    const before = onlyFriend(b)

    // A re-sends its request over the wire (e.g. after a restart); B is
    // already friends, so B answers without recreating the record.
    b.chat.host.onPairingRequest({ peerId: idOf(a), displayName: 'A' })
    await vi.waitFor(() => { expect(b.transport.pairingResponses).toHaveLength(2) })
    expect(b.chat.listPendingPairings()).toEqual([])
    expect(onlyFriend(b)).toEqual(before)
    expect(b.transport.pairingResponses.at(-1)).toEqual({ peerId: idOf(a), accept: true })
  })

  it('auto-accepts a simultaneous mutual request', async () => {
    const a = await harness({ displayName: 'A' })
    const b = await harness({ displayName: 'B' })
    harnesses.push(a, b)

    // Both sides request before either request crosses the wire.
    a.chat.host.onPeerDiscovered({ peerId: idOf(b), displayName: 'B' })
    b.chat.host.onPeerDiscovered({ peerId: idOf(a), displayName: 'A' })
    await a.chat.requestPairing(idOf(b))
    await b.chat.requestPairing(idOf(a))

    a.chat.host.onPairingRequest({ peerId: idOf(b), displayName: 'B' })
    b.chat.host.onPairingRequest({ peerId: idOf(a), displayName: 'A' })
    await paired(a, idOf(b))
    await paired(b, idOf(a))

    expect(a.chat.listPendingPairings()).toEqual([])
    expect(b.chat.listPendingPairings()).toEqual([])
    expect(a.chat.listFriends()).toHaveLength(1)
    expect(b.chat.listFriends()).toHaveLength(1)
    expect(onlyFriend(a).fingerprint).toBe(onlyFriend(b).fingerprint)
  })

  it('keeps the local accept decision when the auto-accept response cannot be transmitted', async () => {
    const a = await harness({ displayName: 'A' })
    const b = await harness({ displayName: 'B' })
    harnesses.push(a, b)
    b.transport.transmitPairingResponse = async () => {
      throw new ChatError('peer-offline', 'requester vanished')
    }

    // Both sides request; B's auto-accept of A's crossing request cannot be
    // answered, but the friend record is already durable.
    a.chat.host.onPeerDiscovered({ peerId: idOf(b), displayName: 'B' })
    b.chat.host.onPeerDiscovered({ peerId: idOf(a), displayName: 'A' })
    await a.chat.requestPairing(idOf(b))
    await b.chat.requestPairing(idOf(a))
    b.chat.host.onPairingRequest({ peerId: idOf(a), displayName: 'A' })
    await paired(b, idOf(a))
    expect(b.chat.listFriends()).toHaveLength(1)
  })
})

describe('friend records', () => {
  it('removes friends and emits the change', async () => {
    const a = await harness()
    const b = await harness()
    harnesses.push(a, b)
    const events: unknown[] = []
    a.ctx.on('chat/friend-changed', (payload) => { events.push(payload) })

    await pair(a, b)
    expect(await a.chat.removeFriend(idOf(b))).toBe(true)
    expect(events.at(-1)).toMatchObject({ peerId: idOf(b), operation: 'removed' })
    expect(await a.chat.removeFriend(idOf(b))).toBe(false)
  })

  it('renames friends locally with validation', async () => {
    const a = await harness()
    const b = await harness()
    harnesses.push(a, b)
    const events: unknown[] = []
    a.ctx.on('chat/friend-changed', (payload) => { events.push(payload) })

    await expect(a.chat.renameFriend(idOf(b), 'Anyone')).rejects.toMatchObject({ code: 'not-paired' })
    await pair(a, b)
    await expect(a.chat.renameFriend(idOf(b), ' ')).rejects.toMatchObject({ code: 'invalid-name' })
    const renamed = await a.chat.renameFriend(idOf(b), 'Buddy')
    expect(renamed.displayName).toBe('Buddy')
    expect(onlyFriend(a).displayName).toBe('Buddy')
    expect(events.at(-1)).toMatchObject({ peerId: idOf(b), operation: 'renamed' })
  })

  it('reflects the transport reachability belief in listFriends', async () => {
    const a = await harness()
    const b = await harness()
    harnesses.push(a, b)
    await pair(a, b)
    expect(onlyOnline(a)).toBe(false)
    a.transport.reachable.add(idOf(b))
    expect(onlyOnline(a)).toBe(true)
  })

  it('reloads friends and messages from storage after a restart', async () => {
    const a = await harness()
    const b = await harness()
    harnesses.push(b)
    await pair(a, b)
    await sendAcross(a, b, 'kept')
    const ownId = idOf(a)
    const friendBefore = onlyFriend(a)
    await a.dispose()

    // Reopen the same medium without a transport: the friend lists offline.
    const reopened = await rawContext(a.pool)
    disposables.push(reopened.dispose)
    const chat = await reopened.mountChat()
    expect(chat.identity.peerId).toBe(ownId)
    const friends = chat.listFriends()
    const [friend] = friends
    if (friend === undefined) throw new Error('expected the friend record to survive the restart')
    expect(friend.online).toBe(false)
    expect(friend.record).toEqual(friendBefore)
    expect(chat.messages(idOf(b)).map(entry => entry.text)).toEqual(['kept'])
  })
})

describe('presence', () => {
  it('emits on first sight and rename, silently refreshes repeats, and emits on expiry', async () => {
    const h = await harness()
    harnesses.push(h)
    const events: { peerId: PeerId; online: boolean }[] = []
    h.ctx.on('chat/presence', (payload) => { events.push(payload) })

    h.chat.host.onPeerDiscovered({ peerId: peer('p1'), displayName: 'P1' })
    expect(events).toEqual([{ peerId: peer('p1'), online: true }])
    expect(h.chat.listDiscoveredPeers()).toMatchObject([{ peerId: peer('p1'), transport: 'fake' }])

    // Repeat announcement with the same name: refresh, no event.
    h.chat.host.onPeerDiscovered({ peerId: peer('p1'), displayName: 'P1' })
    expect(events).toHaveLength(1)

    // Renamed peer: presence re-announced.
    h.chat.host.onPeerDiscovered({ peerId: peer('p1'), displayName: 'P1-renamed' })
    expect(events).toHaveLength(2)

    h.chat.host.onPeerDiscovered({ peerId: peer('p2'), displayName: 'P2' })
    h.chat.host.onPeerExpired(peer('p1'))
    expect(events).toEqual([
      { peerId: peer('p1'), online: true },
      { peerId: peer('p1'), online: true },
      { peerId: peer('p2'), online: true },
      { peerId: peer('p1'), online: false },
    ])
    expect(h.chat.listDiscoveredPeers().map(entry => entry.peerId)).toEqual([peer('p2')])

    // Expiring an unknown peer is a no-op.
    h.chat.host.onPeerExpired(peer('missing'))
    expect(events).toHaveLength(4)
  })

  it('reports unknown transport names before any transport registers', async () => {
    const raw = await rawContext()
    disposables.push(raw.dispose)
    const chat = await raw.mountChat()
    chat.host.onPeerDiscovered({ peerId: peer('p1'), displayName: 'P1' })
    expect(chat.listDiscoveredPeers()).toMatchObject([{ peerId: peer('p1'), transport: 'unknown' }])
    // A pairing request without a transport is dropped silently.
    chat.host.onPairingRequest({ peerId: peer('p2'), displayName: 'P2' })
    expect(chat.listPendingPairings()).toEqual([])
  })

  it('orders discovered peers by most recent announcement', async () => {
    const h = await harness()
    harnesses.push(h)
    // Distinct announcement timestamps: freeze Date and step it forward.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(1_000)
      h.chat.host.onPeerDiscovered({ peerId: peer('older'), displayName: 'Older' })
      vi.setSystemTime(2_000)
      h.chat.host.onPeerDiscovered({ peerId: peer('newer'), displayName: 'Newer' })
    } finally {
      vi.useRealTimers()
    }
    expect(h.chat.listDiscoveredPeers().map(entry => entry.peerId)).toEqual([peer('newer'), peer('older')])
  })
})

describe('send', () => {
  it('validates transport, friendship, and text before touching the wire', async () => {
    // No transport registered at all.
    const raw = await rawContext()
    disposables.push(raw.dispose)
    const chat = await raw.mountChat()
    await expect(chat.send(peer('x'), 'hi')).rejects.toMatchObject({ code: 'transport-unavailable' })

    const h = await harness()
    const b = await harness()
    harnesses.push(h, b)
    await expect(h.chat.send(peer('x'), 'hi')).rejects.toMatchObject({ code: 'not-paired' })
    await pair(h, b)
    await expect(h.chat.send(idOf(b), '   ')).rejects.toMatchObject({ code: 'invalid-message' })
    await expect(h.chat.send(idOf(b), 'x'.repeat(4001))).rejects.toMatchObject({ code: 'message-too-long' })
    expect(h.transport.pendingDeliveries).toEqual([])
  })

  it('persists the outbound record and emits only after the peer ack', async () => {
    const a = await harness()
    const b = await harness()
    harnesses.push(a, b)
    await pair(a, b)
    const events: ChatMessageRecord[] = []
    a.ctx.on('chat/message', ({ message }) => { events.push(message) })

    const sending = a.chat.send(idOf(b), 'hello')
    await vi.waitFor(() => { expect(a.transport.pendingDeliveries).toHaveLength(1) })
    expect(a.chat.messages(idOf(b))).toEqual([])
    expect(events).toEqual([])

    const pending = a.transport.pendingDeliveries.shift()
    if (pending === undefined) throw new Error('test bug: the outbound delivery vanished')
    expect(await b.chat.host.onMessage(idOf(a), pending.message)).toBe(true)
    pending.resolve()
    const record = await sending
    expect(record).toMatchObject({ peerId: idOf(b), direction: 'out', text: 'hello' })
    expect(events).toEqual([record])
    expect(a.changes.filter(change => change.table === 'messages' && change.operation === 'put')).toHaveLength(1)
  })

  it('persists nothing when the transport refuses the delivery', async () => {
    const a = await harness()
    const b = await harness()
    harnesses.push(a, b)
    await pair(a, b)
    a.transport.deliverError = new ChatError('peer-offline', 'peer is offline')
    await expect(a.chat.send(idOf(b), 'lost')).rejects.toMatchObject({ code: 'peer-offline' })
    expect(a.chat.messages(idOf(b))).toEqual([])
  })

  it('respects the configured message-size limit', async () => {
    const h = await harness({ maxMessageChars: 5 })
    const b = await harness()
    harnesses.push(h, b)
    await pair(h, b)
    await expect(h.chat.send(idOf(b), '123456')).rejects.toMatchObject({ code: 'message-too-long' })
    expect(await sendAcross(h, b, '12345')).toMatchObject({ text: '12345' })
  })
})

describe('inbound messages', () => {
  it('refuses unpaired, malformed, and oversized messages without an ack', async () => {
    const a = await harness()
    const b = await harness()
    harnesses.push(a, b)

    // Not a friend yet.
    expect(await a.chat.host.onMessage(idOf(b), message('m0', 'hi'))).toBe(false)

    await pair(a, b)
    expect(await a.chat.host.onMessage(idOf(b), message('m1', ' '))).toBe(false)
    expect(await a.chat.host.onMessage(idOf(b), message('m2', 'x'.repeat(4001)))).toBe(false)
    expect(await a.chat.host.onMessage(idOf(b), message('m3', 'ok', Number.NaN))).toBe(false)
    expect(await a.chat.host.onMessage(idOf(b), message('m4', 'ok', -1))).toBe(false)
    expect(a.chat.messages(idOf(b))).toEqual([])
  })

  it('persists the inbound record, emits, injects, and dedups by message id', async () => {
    const a = await harness()
    const b = await harness()
    harnesses.push(a, b)
    const events: ChatMessageRecord[] = []
    a.ctx.on('chat/message', ({ message }) => { events.push(message) })
    const agent = fakeAgent(500)
    a.setRoots(agent.agent)

    await pair(a, b)
    expect(await a.chat.host.onMessage(idOf(b), message('m1', 'ping', 42))).toBe(true)

    const stored = a.chat.messages(idOf(b))
    const [storedRecord] = stored
    if (storedRecord === undefined) throw new Error('expected the stored inbound record')
    expect(storedRecord).toEqual({
      messageId: mid('m1'),
      peerId: idOf(b),
      direction: 'in',
      text: 'ping',
      sentAt: 42,
      deliveredAt: storedRecord.deliveredAt,
    })
    expect(events).toEqual([storedRecord])
    expect(agent.inject).toHaveBeenCalledTimes(1)
    const injected = injectedMessage(agent)
    expect(injected.content).toHaveLength(1)
    expect(injected.content.at(0)).toMatchObject({ type: 'text', text: `Friend ${b.chat.identity.displayName} says: ping` })
    expect(injected.source).toEqual({ kind: 'chat', form: 'relay' })

    // Replay of the same message id acks true but stores nothing new.
    expect(await a.chat.host.onMessage(idOf(b), message('m1', 'ping', 42))).toBe(true)
    expect(a.chat.messages(idOf(b))).toHaveLength(1)
    expect(agent.inject).toHaveBeenCalledTimes(1)
  })

  it('refuses the ack when durability fails so the sender can retry', async () => {
    const a = await harness()
    const b = await harness()
    harnesses.push(a, b)
    await pair(a, b)
    a.pool.failNextWrites = 1
    expect(await a.chat.host.onMessage(idOf(b), message('m2', 'again', 7))).toBe(false)
    a.pool.failNextWrites = 0
    expect(await a.chat.host.onMessage(idOf(b), message('m2', 'again', 7))).toBe(true)
    expect(a.chat.messages(idOf(b))).toHaveLength(1)
  })

  it('skips injection when configured off', async () => {
    const h = await harness({ injectInto: 'none' })
    const b = await harness()
    harnesses.push(h, b)
    const agent = fakeAgent(500)
    h.setRoots(agent.agent)
    await pair(h, b)
    await sendAcross(b, h, 'quiet')
    expect(agent.inject).not.toHaveBeenCalled()
    expect(h.chat.messages(idOf(b))).toHaveLength(1)
  })

  it('injects into the most recently active root agent', async () => {
    const h = await harness()
    const b = await harness()
    harnesses.push(h, b)
    const older = fakeAgent(100)
    const newer = fakeAgent(900)
    // Newest-first order: selection must follow activity, not iteration order.
    h.setRoots(newer.agent, older.agent)
    await pair(h, b)
    await sendAcross(b, h, 'hello')
    expect(older.inject).not.toHaveBeenCalled()
    expect(newer.inject).toHaveBeenCalledTimes(1)

    // An empty log falls back to the header creation time, which wins here.
    const emptyLog = fakeAgent(undefined, 1000)
    h.setRoots(newer.agent, emptyLog.agent)
    await sendAcross(b, h, 'again')
    expect(newer.inject).toHaveBeenCalledTimes(1)
    expect(emptyLog.inject).toHaveBeenCalledTimes(1)
    const block = injectedMessage(emptyLog).content.at(0)
    if (block === undefined || block.type !== 'text') throw new Error('expected an injected text block')
    expect(block.text).toContain('says:')
  })

  it('warns and still accepts when no root agent exists to receive the injection', async () => {
    const h = await harness()
    const b = await harness()
    harnesses.push(h, b)
    await pair(h, b)
    await expect(sendAcross(b, h, 'alone')).resolves.toMatchObject({ text: 'alone' })
    expect(h.chat.messages(idOf(b))).toHaveLength(1)
  })
})

describe('message history', () => {
  it('orders the thread by (sentAt, messageId) and windows to the most recent limit', async () => {
    const a = await harness()
    const b = await harness()
    harnesses.push(a, b)
    await pair(a, b)

    // Control the send clock; the delivery handshake itself needs real timers.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(1_000)
      await sendAcross(a, b, 'first')
      await a.chat.host.onMessage(idOf(b), message('z-late', 'z-late', 2_000))
      await a.chat.host.onMessage(idOf(b), message('a-late', 'a-late', 2_000))
      vi.setSystemTime(1_500)
      await sendAcross(a, b, 'last')
    } finally {
      vi.useRealTimers()
    }

    const thread = a.chat.messages(idOf(b))
    expect(thread.map(entry => entry.text)).toEqual(['first', 'last', 'a-late', 'z-late'])
    expect(a.chat.messages(idOf(b), 2).map(entry => entry.text)).toEqual(['a-late', 'z-late'])
    expect(a.chat.messages(idOf(b), 100)).toHaveLength(4)
  })
})

describe('host identity', () => {
  it('hands out one stable host object', async () => {
    const h = await harness()
    harnesses.push(h)
    const host: ChatTransportHost = h.chat.host
    expect(h.chat.host).toBe(host)
    expect(h.chat.listPendingPairings()).toEqual([])
  })
})
