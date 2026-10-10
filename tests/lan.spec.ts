import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSocket } from 'node:dgram'
import { createServer } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ChatIdentity, ChatMessageId, ChatTransportHost, InboundChatMessage, PeerAnnouncement, PeerId } from '@deepseek-ai/dsh-chat'
import { ChatError } from '@deepseek-ai/dsh-chat'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import ChatRuntime from '@deepseek-ai/dsh-chat'
import ChatLan from '../src/lan/index.ts'
import { parseDirectPeer, resolveLanConfig } from '../src/lan/config.ts'
import type { ChatLanConfig, LanConfig } from '../src/lan/config.ts'
import { decodeFrame, encodeFrame } from '../src/lan/protocol.ts'
import type { AnnounceFrame, LanFrame } from '../src/lan/protocol.ts'
import { LanTransport } from '../src/lan/transport.ts'
import type { DialFactory, DiscoverySocket, WireEndpoint, WireEvent, WireSocket } from '../src/lan/transport.ts'

const peer = (value: string): PeerId => brandString<PeerId>(value)
const mid = (value: string): ChatMessageId => brandString<ChatMessageId>(value)

const SELF: ChatIdentity = { peerId: peer('self'), displayName: 'self-home' }

/** One announce frame as tests inject it. */
const announce = (peerId: string, tcpPort: number, displayName = 'Peer'): AnnounceFrame =>
  ({ v: 1, kind: 'announce', peerId: peer(peerId), displayName, tcpPort })

/** Host double: records every callback; inbound messages stay pending until the test decides. */
function recordingHost(): ChatTransportHost & {
  readonly discovered: PeerAnnouncement[]
  readonly expired: PeerId[]
  readonly pairingRequests: PeerAnnouncement[]
  readonly pairingResponses: { peerId: PeerId; accept: boolean }[]
  readonly inbound: { peerId: PeerId; message: InboundChatMessage; accept: (accepted: boolean) => void }[]
} {
  const discovered: PeerAnnouncement[] = []
  const expired: PeerId[] = []
  const pairingRequests: PeerAnnouncement[] = []
  const pairingResponses: { peerId: PeerId; accept: boolean }[] = []
  const inbound: { peerId: PeerId; message: InboundChatMessage; accept: (accepted: boolean) => void }[] = []
  return {
    discovered,
    expired,
    pairingRequests,
    pairingResponses,
    inbound,
    onPeerDiscovered: (announcement) => { discovered.push(announcement) },
    onPeerExpired: (peerId) => { expired.push(peerId) },
    onPairingRequest: (announcement) => { pairingRequests.push(announcement) },
    onPairingResponse: (peerId, accept) => { pairingResponses.push({ peerId, accept }) },
    onMessage: (peerId, message) => new Promise<boolean>((resolve) => {
      inbound.push({ peerId, message, accept: resolve })
    }),
  }
}
type RecordingHost = ReturnType<typeof recordingHost>

/** UDP discovery double: records sends, replays datagrams and errors on demand. */
class FakeDiscoverySocket implements DiscoverySocket {
  readonly sent: { payload: string; port: number; address: string }[] = []
  bound = false
  endpointValue: WireEndpoint = { address: '127.0.0.1', port: 41000 }
  bindError: Error | undefined

  constructor(private readonly handlers: { onMessage: (payload: string, from: WireEndpoint) => void; onError: (error: Error) => void }) {}

  bind = async (port: number, address: string): Promise<void> => {
    if (this.bindError !== undefined) throw this.bindError
    this.bound = true
    this.endpointValue = { address, port: port === 0 ? 41000 : port }
  }

  endpoint = (): WireEndpoint => this.endpointValue

  send = (payload: string, port: number, address: string): void => {
    this.sent.push({ payload, port, address })
  }

  close = async (): Promise<void> => {
    this.bound = false
  }

  emitMessage = (payload: string, from: WireEndpoint): void => { this.handlers.onMessage(payload, from) }

  emitError = (error: Error): void => { this.handlers.onError(error) }
}

/** TCP wire double: records writes, replays events on demand. */
class FakeWire implements WireSocket {
  readonly sent: string[] = []
  destroyed = false
  setNoDelayCalled = false
  private readonly listeners = new Map<WireEvent, ((...args: unknown[]) => void)[]>()

  constructor(readonly remoteAddress: string | undefined = '127.0.0.1') {}

  write = (payload: string): boolean => {
    this.sent.push(payload)
    return true
  }

  destroy = (): void => {
    this.destroyed = true
  }

  setNoDelay = (): void => {
    this.setNoDelayCalled = true
  }

  on = (event: WireEvent, listener: (...args: unknown[]) => void): this => {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
    return this
  }

  removeListener = (event: WireEvent, listener: (...args: unknown[]) => void): this => {
    this.listeners.set(event, (this.listeners.get(event) ?? []).filter(entry => entry !== listener))
    return this
  }

  emit = (event: WireEvent, ...args: unknown[]): void => {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args)
  }
}

/** A wire without the optional setNoDelay, for the adapter's optional-call path. */
function bareWire(): WireSocket {
  const wire = new FakeWire()
  Reflect.deleteProperty(wire, 'setNoDelay')
  return wire
}

interface LanHarness {
  transport: LanTransport
  readonly host: RecordingHost
  readonly warns: string[]
  readonly discovery: { socket: FakeDiscoverySocket | undefined }
  readonly serve: { connections: ((wire: WireSocket) => void)[] }
}

/** Transport over fake sockets; the frame logic runs unmodified. */
function lanHarness(config: Partial<LanConfig> = {}, dial?: DialFactory, now?: () => number): LanHarness {
  const host = recordingHost()
  const warns: string[] = []
  const discovery: { socket: FakeDiscoverySocket | undefined } = { socket: undefined }
  const serve: { connections: ((wire: WireSocket) => void)[] } = { connections: [] }
  const transport = new LanTransport({
    self: () => SELF,
    config: { ...resolveLanConfig({}), ...config },
    host,
    warn: (message) => { warns.push(message) },
    discovery: (_port, _address, handlers) => {
      const socket = new FakeDiscoverySocket(handlers)
      discovery.socket = socket
      return socket
    },
    serve: (_port, _address, onConnection) => {
      serve.connections.push(onConnection)
      return Promise.resolve({ port: 41111, close: async () => {} })
    },
    ...(dial === undefined ? {} : { dial }),
    ...(now === undefined ? {} : { now }),
  })
  return { transport, host, warns, discovery, serve }
}

function discoverySocket(h: LanHarness): FakeDiscoverySocket {
  const socket = h.discovery.socket
  if (socket === undefined) throw new Error('transport is not started')
  return socket
}

function serveConnection(h: LanHarness, wire: WireSocket): void {
  const connect = h.serve.connections.at(-1)
  if (connect === undefined) throw new Error('transport is not started')
  connect(wire)
}

function wireLine(wire: FakeWire, frame: LanFrame): void {
  wire.emit('data', encodeFrame(frame))
}

function parsed(payload: string): LanFrame {
  const decoded = decodeFrame(payload)
  if (typeof decoded === 'string') throw new Error(`undecodable frame: ${decoded}`)
  return decoded
}

function wireFrame(wire: FakeWire, index: number): LanFrame {
  const line = wire.sent.at(index)
  if (line === undefined) throw new Error(`no frame at ${index}`)
  return parsed(line)
}

/** Rejecting counterpart of a promise: returns the ChatError it failed with. */
async function failure(promise: Promise<unknown>): Promise<ChatError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ChatError) return error
    throw new Error(`non-ChatError failure: ${String(error)}`)
  }
  throw new Error('expected the promise to reject')
}

describe('config resolution', () => {
  it('falls back to the documented defaults', () => {
    expect(resolveLanConfig({})).toEqual({
      enabled: true,
      displayName: undefined,
      discoveryPort: 41888,
      transportPort: 0,
      bindAddress: '0.0.0.0',
      broadcastAddress: '255.255.255.255',
      presenceIntervalMs: 3000,
      presenceTtlMs: 9000,
      requestTimeoutMs: 5000,
      directPeers: [],
    })
  })

  it('keeps every supplied override', () => {
    const config: ChatLanConfig = {
      enabled: false,
      displayName: 'Named',
      discoveryPort: 5000,
      transportPort: 5001,
      bindAddress: '127.0.0.1',
      broadcastAddress: '10.0.0.255',
      presenceIntervalMs: 100,
      presenceTtlMs: 200,
      requestTimeoutMs: 300,
      directPeers: ['127.0.0.1:5000'],
    }
    expect(resolveLanConfig(config)).toEqual(config)
  })

  it('parses direct peer targets', () => {
    expect(parseDirectPeer('127.0.0.1:5000')).toEqual({ host: '127.0.0.1', port: 5000 })
    expect(parseDirectPeer('a:b:3000')).toEqual({ host: 'a:b', port: 3000 })
    expect(parseDirectPeer('host')).toBeUndefined()
    expect(parseDirectPeer(':5000')).toBeUndefined()
    expect(parseDirectPeer('host:')).toBeUndefined()
    expect(parseDirectPeer('host:abc')).toBeUndefined()
    expect(parseDirectPeer('host:0')).toBeUndefined()
    expect(parseDirectPeer('host:-1')).toBeUndefined()
    expect(parseDirectPeer('host:70000')).toBeUndefined()
  })
})

describe('start and announce', () => {
  it('announces immediately to the broadcast address and direct peers', async () => {
    const h = lanHarness({ directPeers: ['127.0.0.1:42001', 'not-a-peer', '[::1]:42002'] })
    await h.transport.start()
    const socket = discoverySocket(h)
    const targets = socket.sent.map(entry => `${entry.address}:${entry.port}`)
    expect(targets).toContain('255.255.255.255:41888')
    expect(targets).toContain('127.0.0.1:42001')
    expect(targets).toContain('[::1]:42002')
    expect(h.warns.some(message => message.includes('not-a-peer'))).toBe(true)
    const frame = parsed(socket.sent.at(0)?.payload ?? '')
    expect(frame).toEqual({
      v: 1,
      kind: 'announce',
      peerId: SELF.peerId,
      displayName: 'self-home',
      tcpPort: 41111,
    })
    expect(h.transport.discoveryPort).toBe(41888)
    expect(h.transport.servingPort).toBe(41111)
    await h.transport.stop()
  })

  it('reports zero ports before it starts', () => {
    const h = lanHarness()
    expect(h.transport.discoveryPort).toBe(0)
    expect(h.transport.servingPort).toBe(0)
  })

  it('propagates discovery bind failures', async () => {
    const h = lanHarness()
    const socket = new FakeDiscoverySocket({ onMessage: () => {}, onError: () => {} })
    socket.bindError = new Error('EACCES')
    h.discovery.socket = socket
    h.transport = new LanTransport({
      self: () => SELF,
      config: resolveLanConfig({}),
      host: h.host,
      warn: () => {},
      discovery: () => socket,
      serve: () => Promise.resolve({ port: 41111, close: async () => {} }),
    })
    await expect(h.transport.start()).rejects.toThrow('EACCES')
    expect(socket.bound).toBe(false)
  })

  it('propagates serve failures after closing discovery', async () => {
    const h = lanHarness()
    h.transport = new LanTransport({
      self: () => SELF,
      config: resolveLanConfig({}),
      host: h.host,
      warn: () => {},
      discovery: (_port, _address, handlers) => {
        const socket = new FakeDiscoverySocket(handlers)
        h.discovery.socket = socket
        return socket
      },
      serve: () => Promise.reject(new Error('EADDRINUSE')),
    })
    await expect(h.transport.start()).rejects.toThrow('EADDRINUSE')
    expect(discoverySocket(h).bound).toBe(false)
    await expect(h.transport.stop()).resolves.toBeUndefined()
  })
})

describe('discovery', () => {
  it('discovers a peer and unicast-replies on first sight', async () => {
    const h = lanHarness()
    await h.transport.start()
    const socket = discoverySocket(h)
    socket.sent.length = 0
    socket.emitMessage(encodeFrame(announce('p1', 43001, 'Peer One')), { address: '10.0.0.9', port: 42000 })
    expect(h.host.discovered).toEqual([{ peerId: peer('p1'), displayName: 'Peer One' }])
    expect(h.transport.isReachable(peer('p1'))).toBe(true)
    const replies = socket.sent.filter(entry => entry.address === '10.0.0.9')
    expect(replies).toHaveLength(1)
    expect(parsed(replies.at(0)?.payload ?? '')).toMatchObject({ kind: 'announce', peerId: SELF.peerId, tcpPort: 41111 })
    socket.emitMessage(encodeFrame(announce('p1', 43001, 'Peer One')), { address: '10.0.0.9', port: 42000 })
    expect(socket.sent.filter(entry => entry.address === '10.0.0.9')).toHaveLength(1)
    await h.transport.stop()
  })

  it('replies again once the peer was quiet past the interval', async () => {
    let clock = 1000
    const h = lanHarness({ presenceIntervalMs: 100 }, undefined, () => clock)
    await h.transport.start()
    const socket = discoverySocket(h)
    const from: WireEndpoint = { address: '10.0.0.9', port: 42000 }
    socket.emitMessage(encodeFrame(announce('p1', 43001)), from)
    clock = 1050
    socket.emitMessage(encodeFrame(announce('p1', 43001)), from)
    expect(socket.sent.filter(entry => entry.address === '10.0.0.9')).toHaveLength(1)
    clock = 1250
    socket.emitMessage(encodeFrame(announce('p1', 43001)), from)
    expect(socket.sent.filter(entry => entry.address === '10.0.0.9')).toHaveLength(2)
    await h.transport.stop()
  })

  it('ignores its own announcements', async () => {
    const h = lanHarness()
    await h.transport.start()
    discoverySocket(h).emitMessage(encodeFrame(announce('self', 41111, 'self-home')), { address: '127.0.0.1', port: 41000 })
    expect(h.host.discovered).toEqual([])
    await h.transport.stop()
  })

  it('counts foreign protocol versions and warns once', async () => {
    const h = lanHarness()
    await h.transport.start()
    const socket = discoverySocket(h)
    const stale = JSON.stringify({ ...announce('p1', 43001), v: 99 })
    socket.emitMessage(stale, { address: '10.0.0.9', port: 42000 })
    socket.emitMessage(stale, { address: '10.0.0.9', port: 42000 })
    expect(h.transport.staleVersionCount).toBe(2)
    expect(h.warns.filter(message => message.includes('protocol version'))).toHaveLength(1)
    expect(h.host.discovered).toEqual([])
    await h.transport.stop()
  })

  it('warns on malformed datagrams and silently drops non-announce kinds', async () => {
    const h = lanHarness()
    await h.transport.start()
    const socket = discoverySocket(h)
    const from: WireEndpoint = { address: '10.0.0.9', port: 42000 }
    socket.emitMessage('not json', from)
    expect(h.warns.some(message => message.includes('malformed datagram'))).toBe(true)
    const warnsBefore = h.warns.length
    socket.emitMessage(encodeFrame({ v: 1, kind: 'message', peerId: peer('p1'), messageId: mid('m1'), text: 'x', sentAt: 1 }), from)
    expect(h.warns).toHaveLength(warnsBefore)
    expect(h.host.discovered).toEqual([])
    await h.transport.stop()
  })

  it('warns when the discovery socket errors', async () => {
    const h = lanHarness()
    await h.transport.start()
    discoverySocket(h).emitError(new Error('send boom'))
    expect(h.warns.some(message => message.includes('send boom'))).toBe(true)
    await h.transport.stop()
  })

  it('expires peers whose announcements stop', async () => {
    const h = lanHarness({ presenceIntervalMs: 5, presenceTtlMs: 20 })
    await h.transport.start()
    discoverySocket(h).emitMessage(encodeFrame(announce('p1', 43001)), { address: '10.0.0.9', port: 42000 })
    expect(h.transport.isReachable(peer('p1'))).toBe(true)
    await vi.waitFor(() => {
      expect(h.host.expired).toEqual([peer('p1')])
    })
    expect(h.transport.isReachable(peer('p1'))).toBe(false)
    await h.transport.stop()
  })

  it('learns about peers from announces carried on a chat connection too', async () => {
    const h = lanHarness()
    await h.transport.start()
    const wire = new FakeWire()
    serveConnection(h, wire)
    wireLine(wire, announce('p1', 43001, 'Wire Peer'))
    expect(h.host.discovered).toEqual([{ peerId: peer('p1'), displayName: 'Wire Peer' }])
    await h.transport.stop()
  })
})

describe('wire frames', () => {
  it('routes a pairing request into the host and touches the peer', async () => {
    const h = lanHarness()
    await h.transport.start()
    const wire = new FakeWire()
    Reflect.deleteProperty(wire, 'remoteAddress')
    serveConnection(h, wire)
    wireLine(wire, { v: 1, kind: 'pair-request', peerId: peer('p1'), displayName: 'Peer One' })
    expect(h.host.pairingRequests).toEqual([{ peerId: peer('p1'), displayName: 'Peer One' }])
    expect(h.transport.isReachable(peer('p1'))).toBe(true)
    await h.transport.stop()
  })

  it('routes a pairing response into the host', async () => {
    const h = lanHarness()
    await h.transport.start()
    const wire = new FakeWire()
    serveConnection(h, wire)
    wireLine(wire, { v: 1, kind: 'pair-response', peerId: peer('p1'), accept: false })
    expect(h.host.pairingResponses).toEqual([{ peerId: peer('p1'), accept: false }])
    await h.transport.stop()
  })

  it('acks an inbound message after the host accepts it', async () => {
    const h = lanHarness()
    await h.transport.start()
    const wire = new FakeWire()
    serveConnection(h, wire)
    wireLine(wire, { v: 1, kind: 'message', peerId: peer('p1'), messageId: mid('m1'), text: 'hello', sentAt: 5 })
    const call = h.host.inbound.at(0)
    if (call === undefined) throw new Error('the message never reached the host')
    expect(call.peerId).toBe(peer('p1'))
    expect(call.message).toEqual({ messageId: mid('m1'), text: 'hello', sentAt: 5 })
    call.accept(true)
    await vi.waitFor(() => {
      expect(wire.sent).toHaveLength(1)
    })
    expect(wireFrame(wire, 0)).toEqual({ v: 1, kind: 'ack', peerId: SELF.peerId, messageId: mid('m1'), accepted: true })
    await h.transport.stop()
  })

  it('acks refusal when the host declines or throws', async () => {
    const h = lanHarness()
    await h.transport.start()
    const wire = new FakeWire()
    serveConnection(h, wire)
    wireLine(wire, { v: 1, kind: 'message', peerId: peer('p1'), messageId: mid('m1'), text: 'x', sentAt: 1 })
    const declined = h.host.inbound.at(0)
    if (declined === undefined) throw new Error('the message never reached the host')
    declined.accept(false)
    await vi.waitFor(() => {
      expect(wire.sent).toHaveLength(1)
    })
    expect(wireFrame(wire, 0)).toMatchObject({ kind: 'ack', accepted: false })
    wireLine(wire, { v: 1, kind: 'message', peerId: peer('p1'), messageId: mid('m2'), text: 'y', sentAt: 2 })
    const throwing = h.host.inbound.at(1)
    if (throwing === undefined) throw new Error('the second message never reached the host')
    throwing.accept(true)
    h.host.onMessage = (): Promise<boolean> => Promise.reject(new Error('host down'))
    wireLine(wire, { v: 1, kind: 'message', peerId: peer('p1'), messageId: mid('m3'), text: 'z', sentAt: 3 })
    await vi.waitFor(() => {
      expect(wire.sent).toHaveLength(3)
    })
    expect(wireFrame(wire, 2)).toMatchObject({ kind: 'ack', accepted: false })
    await h.transport.stop()
  })

  it('warns on a failed ack write after the wire closed', async () => {
    const h = lanHarness()
    await h.transport.start()
    const wire = new FakeWire()
    serveConnection(h, wire)
    wireLine(wire, { v: 1, kind: 'message', peerId: peer('p1'), messageId: mid('m1'), text: 'x', sentAt: 1 })
    const call = h.host.inbound.at(0)
    if (call === undefined) throw new Error('the message never reached the host')
    wire.emit('close')
    call.accept(true)
    await vi.waitFor(() => {
      expect(h.warns.some(message => message.includes('ack for message'))).toBe(true)
    })
    await h.transport.stop()
  })

  it('warns on wire error events with and without an error object', async () => {
    const h = lanHarness()
    await h.transport.start()
    const wire = new FakeWire()
    serveConnection(h, wire)
    wire.emit('error', new Error('boom'))
    wire.emit('error', 'weird')
    expect(h.warns).toEqual(['connection error: boom', 'connection error'])
    await h.transport.stop()
  })

  it('ignores acks for messages it never sent', async () => {
    const h = lanHarness()
    await h.transport.start()
    const wire = new FakeWire()
    serveConnection(h, wire)
    wireLine(wire, { v: 1, kind: 'ack', peerId: peer('p1'), messageId: mid('m404'), accepted: true })
    expect(h.warns.some(message => message.includes('unknown message'))).toBe(true)
    await h.transport.stop()
  })

  it('warns on malformed, stale, self, and contradictory frames', async () => {
    const h = lanHarness()
    await h.transport.start()
    const wire = new FakeWire()
    serveConnection(h, wire)
    wire.emit('data', 'garbage\n')
    expect(h.warns.some(message => message.includes('malformed frame'))).toBe(true)
    wire.emit('data', `${JSON.stringify({ ...announce('p1', 1), v: 2 })}\n`)
    expect(h.transport.staleVersionCount).toBe(1)
    wireLine(wire, announce('self', 41111, 'self-home'))
    expect(h.host.discovered).toEqual([])
    wireLine(wire, { v: 1, kind: 'pair-request', peerId: peer('p1'), displayName: 'Peer One' })
    wireLine(wire, { v: 1, kind: 'message', peerId: peer('p2'), messageId: mid('m1'), text: 'x', sentAt: 1 })
    expect(h.host.inbound).toEqual([])
    expect(h.warns.some(message => message.includes('does not match'))).toBe(true)
    await h.transport.stop()
  })

  it('reassembles frames split across chunks and skips empty lines', async () => {
    const h = lanHarness()
    await h.transport.start()
    const wire = new FakeWire()
    serveConnection(h, wire)
    const line = encodeFrame(announce('p1', 43001, 'Chunked'))
    wire.emit('data', `\n\n${line.slice(0, 10)}`)
    wire.emit('data', line.slice(10, 30))
    wire.emit('data', line.slice(30))
    expect(h.host.discovered).toEqual([{ peerId: peer('p1'), displayName: 'Chunked' }])
    expect(h.warns.some(message => message.includes('malformed frame'))).toBe(false)
    await h.transport.stop()
  })

  it('ignores data from wires it never attached and non-string chunks', async () => {
    const h = lanHarness()
    await h.transport.start()
    const detached = new FakeWire()
    detached.emit('data', encodeFrame(announce('p1', 43001)))
    expect(h.host.discovered).toEqual([])
    const wire = new FakeWire()
    serveConnection(h, wire)
    wire.emit('data', 42)
    expect(h.warns).toEqual([])
    wire.emit('close')
    wire.emit('data', encodeFrame(announce('p9', 43001)))
    expect(h.host.discovered).toEqual([])
    await h.transport.stop()
  })

  it('handles wires without setNoDelay', async () => {
    const h = lanHarness()
    await h.transport.start()
    serveConnection(h, bareWire())
    await h.transport.stop()
  })

  it('drops connections that send oversized frames', async () => {
    const h = lanHarness()
    await h.transport.start()
    const wire = new FakeWire()
    serveConnection(h, wire)
    wire.emit('data', `${'x'.repeat(65537)}\n`)
    expect(wire.destroyed).toBe(true)
    expect(h.warns.some(message => message.includes('65537-byte frame'))).toBe(true)
    await h.transport.stop()
  })
})

describe('delivery and dials', () => {
  function dialedHarness(config: Partial<LanConfig> = {}): {
    h: LanHarness
    wires: FakeWire[]
    targets: { port: number; address: string }[]
  } {
    const wires: FakeWire[] = []
    const targets: { port: number; address: string }[] = []
    const dial: DialFactory = async (port, address) => {
      targets.push({ port, address })
      const wire = new FakeWire()
      wires.push(wire)
      return wire
    }
    return { h: lanHarness(config, dial), wires, targets }
  }

  it('dials, delivers, and resolves on the ack', async () => {
    const { h, wires, targets } = dialedHarness()
    await h.transport.start()
    discoverySocket(h).emitMessage(encodeFrame(announce('p1', 43001)), { address: '10.0.0.9', port: 42000 })
    const pending = h.transport.deliver(peer('p1'), { messageId: mid('m1'), text: 'hello', sentAt: 7 })
    await vi.waitFor(() => {
      expect(wires.at(0)?.sent).toHaveLength(1)
    })
    expect(targets.at(0)).toEqual({ port: 43001, address: '10.0.0.9' })
    expect(wireFrame(wires.at(0) ?? new FakeWire(), 0)).toMatchObject({ kind: 'message', text: 'hello' })
    wires.at(0)?.emit('data', encodeFrame({ v: 1, kind: 'ack', peerId: peer('p1'), messageId: mid('m1'), accepted: true }))
    await pending
    const second = h.transport.deliver(peer('p1'), { messageId: mid('m2'), text: 'again', sentAt: 8 })
    await vi.waitFor(() => {
      expect(wires.at(0)?.sent).toHaveLength(2)
    })
    wires.at(0)?.emit('data', encodeFrame({ v: 1, kind: 'ack', peerId: peer('p1'), messageId: mid('m2'), accepted: true }))
    await second
    expect(targets).toHaveLength(1)
    await h.transport.stop()
  })

  it('rejects with not-paired when the peer refuses', async () => {
    const { h, wires } = dialedHarness()
    await h.transport.start()
    discoverySocket(h).emitMessage(encodeFrame(announce('p1', 43001)), { address: '10.0.0.9', port: 42000 })
    const pending = h.transport.deliver(peer('p1'), { messageId: mid('m1'), text: 'hello', sentAt: 7 })
    await vi.waitFor(() => {
      expect(wires.at(0)?.sent).toHaveLength(1)
    })
    wires.at(0)?.emit('data', encodeFrame({ v: 1, kind: 'ack', peerId: peer('p1'), messageId: mid('m1'), accepted: false }))
    expect((await failure(pending)).code).toBe('not-paired')
    await h.transport.stop()
  })

  it('fails the delivery when the ack never arrives', async () => {
    const { h, wires } = dialedHarness({ requestTimeoutMs: 10 })
    await h.transport.start()
    discoverySocket(h).emitMessage(encodeFrame(announce('p1', 43001)), { address: '10.0.0.9', port: 42000 })
    const pending = h.transport.deliver(peer('p1'), { messageId: mid('m1'), text: 'hello', sentAt: 7 })
    const error = await failure(pending)
    expect(error.code).toBe('peer-offline')
    expect(error.message).toContain('did not ack')
    expect(wires.at(0)?.destroyed).toBe(true)
    await h.transport.stop()
  })

  it('fails the delivery when dialing times out and destroys the late wire', async () => {
    let release: ((wire: WireSocket) => void) | undefined
    const dial: DialFactory = (_port, _address) => new Promise<WireSocket>((resolve) => {
      release = resolve
    })
    const h = lanHarness({ requestTimeoutMs: 10 }, dial)
    await h.transport.start()
    discoverySocket(h).emitMessage(encodeFrame(announce('p1', 43001)), { address: '10.0.0.9', port: 42000 })
    const pending = h.transport.deliver(peer('p1'), { messageId: mid('m1'), text: 'hello', sentAt: 7 })
    const error = await failure(pending)
    expect(error.code).toBe('peer-offline')
    expect(error.message).toContain('timed out')
    const late = new FakeWire()
    if (release === undefined) throw new Error('the dial was never attempted')
    release(late)
    await vi.waitFor(() => {
      expect(late.destroyed).toBe(true)
    })
    await h.transport.stop()
  })

  it('ignores a dial that rejects after the deadline', async () => {
    let fail: ((error: Error) => void) | undefined
    const dial: DialFactory = () => new Promise<WireSocket>((_resolve, reject) => {
      fail = reject
    })
    const h = lanHarness({ requestTimeoutMs: 10 }, dial)
    await h.transport.start()
    discoverySocket(h).emitMessage(encodeFrame(announce('p1', 43001)), { address: '10.0.0.9', port: 42000 })
    const error = await failure(h.transport.deliver(peer('p1'), { messageId: mid('m1'), text: 'x', sentAt: 1 }))
    expect(error.message).toContain('timed out')
    if (fail === undefined) throw new Error('the dial was never attempted')
    fail(new Error('late refusal'))
    await new Promise((resolve) => { setTimeout(resolve, 30) })
    await h.transport.stop()
  })

  it('fails the delivery when the frame write throws', async () => {
    const dial: DialFactory = async () => {
      const wire = new FakeWire()
      wire.write = () => { throw new Error('write blew up') }
      return wire
    }
    const h = lanHarness({}, dial)
    await h.transport.start()
    discoverySocket(h).emitMessage(encodeFrame(announce('p1', 43001)), { address: '10.0.0.9', port: 42000 })
    await expect(h.transport.deliver(peer('p1'), { messageId: mid('m1'), text: 'x', sentAt: 1 })).rejects.toThrow('write blew up')
    await h.transport.stop()
  })

  it('maps dial failures to peer-offline', async () => {
    const dial: DialFactory = async () => {
      throw new Error('ECONNREFUSED')
    }
    const h = lanHarness({}, dial)
    await h.transport.start()
    discoverySocket(h).emitMessage(encodeFrame(announce('p1', 43001)), { address: '10.0.0.9', port: 42000 })
    const error = await failure(h.transport.deliver(peer('p1'), { messageId: mid('m1'), text: 'hello', sentAt: 7 }))
    expect(error.code).toBe('peer-offline')
    expect(error.message).toContain('ECONNREFUSED')
    await h.transport.stop()
  })

  it('keeps ChatError identities from the dialer', async () => {
    const dial: DialFactory = async () => {
      throw new ChatError('peer-offline', 'unreachable')
    }
    const h = lanHarness({}, dial)
    await h.transport.start()
    discoverySocket(h).emitMessage(encodeFrame(announce('p1', 43001)), { address: '10.0.0.9', port: 42000 })
    expect((await failure(h.transport.deliver(peer('p1'), { messageId: mid('m1'), text: 'x', sentAt: 1 }))).code).toBe('peer-offline')
    await h.transport.stop()
  })

  it('refuses delivery to unknown and endpoint-less peers', async () => {
    const { h, targets } = dialedHarness()
    await h.transport.start()
    expect((await failure(h.transport.deliver(peer('ghost'), { messageId: mid('m1'), text: 'x', sentAt: 1 }))).code).toBe('peer-unknown')
    const wire = new FakeWire()
    serveConnection(h, wire)
    wireLine(wire, { v: 1, kind: 'pair-request', peerId: peer('p1'), displayName: 'Peer One' })
    wire.emit('close')
    const error = await failure(h.transport.transmitPairingRequest(peer('p1')))
    expect(error.code).toBe('peer-offline')
    expect(error.message).toContain('no known TCP endpoint')
    const secondWire = new FakeWire()
    serveConnection(h, secondWire)
    wireLine(secondWire, announce('p2', 43001, 'Wire Only'))
    secondWire.emit('close')
    const addressError = await failure(h.transport.deliver(peer('p2'), { messageId: mid('m2'), text: 'x', sentAt: 2 }))
    expect(addressError.code).toBe('peer-offline')
    expect(addressError.message).toContain('no known TCP endpoint')
    expect(targets).toEqual([])
    await h.transport.stop()
  })

  it('transmits pairing frames over dialed and existing wires', async () => {
    const { h, wires, targets } = dialedHarness()
    await h.transport.start()
    discoverySocket(h).emitMessage(encodeFrame(announce('p1', 43001)), { address: '10.0.0.9', port: 42000 })
    await h.transport.transmitPairingRequest(peer('p1'))
    await vi.waitFor(() => {
      expect(wires.at(0)?.sent).toHaveLength(1)
    })
    expect(wireFrame(wires.at(0) ?? new FakeWire(), 0)).toEqual({
      v: 1,
      kind: 'pair-request',
      peerId: SELF.peerId,
      displayName: 'self-home',
    })
    const wire = new FakeWire()
    serveConnection(h, wire)
    wireLine(wire, { v: 1, kind: 'pair-request', peerId: peer('p2'), displayName: 'Peer Two' })
    await h.transport.transmitPairingResponse(peer('p2'), true)
    expect(wireFrame(wire, 0)).toEqual({ v: 1, kind: 'pair-response', peerId: SELF.peerId, accept: true })
    expect(targets).toHaveLength(1)
    await h.transport.stop()
  })

  it('re-dials after the wire closes but keeps a replacement wire', async () => {
    const { h, wires, targets } = dialedHarness()
    await h.transport.start()
    discoverySocket(h).emitMessage(encodeFrame(announce('p1', 43001)), { address: '10.0.0.9', port: 42000 })
    const first = h.transport.deliver(peer('p1'), { messageId: mid('m1'), text: 'one', sentAt: 1 })
    await vi.waitFor(() => {
      expect(wires.at(0)?.sent).toHaveLength(1)
    })
    wires.at(0)?.emit('data', encodeFrame({ v: 1, kind: 'ack', peerId: peer('p1'), messageId: mid('m1'), accepted: true }))
    await first
    wires.at(0)?.emit('close')
    const second = h.transport.deliver(peer('p1'), { messageId: mid('m2'), text: 'two', sentAt: 2 })
    await vi.waitFor(() => {
      expect(wires.at(1)?.sent).toHaveLength(1)
    })
    wires.at(1)?.emit('data', encodeFrame({ v: 1, kind: 'ack', peerId: peer('p1'), messageId: mid('m2'), accepted: true }))
    await second
    expect(targets).toHaveLength(2)
    const replacement = new FakeWire()
    serveConnection(h, replacement)
    wireLine(replacement, { v: 1, kind: 'pair-request', peerId: peer('p1'), displayName: 'Peer One' })
    wires.at(0)?.emit('close')
    const third = h.transport.deliver(peer('p1'), { messageId: mid('m3'), text: 'three', sentAt: 3 })
    await vi.waitFor(() => {
      expect(replacement.sent).toHaveLength(1)
    })
    replacement.emit('data', encodeFrame({ v: 1, kind: 'ack', peerId: peer('p1'), messageId: mid('m3'), accepted: true }))
    await third
    expect(targets).toHaveLength(2)
    await h.transport.stop()
  })
})

describe('stop', () => {
  it('rejects pending deliveries and shuts everything down', async () => {
    const dial: DialFactory = async () => new FakeWire()
    const h = lanHarness({ requestTimeoutMs: 60000 }, dial)
    await h.transport.start()
    discoverySocket(h).emitMessage(encodeFrame(announce('p1', 43001)), { address: '10.0.0.9', port: 42000 })
    const pending = h.transport.deliver(peer('p1'), { messageId: mid('m1'), text: 'hello', sentAt: 7 })
    await h.transport.stop()
    expect((await failure(pending)).code).toBe('closed')
    expect(h.transport.isReachable(peer('p1'))).toBe(false)
    await expect(h.transport.start()).rejects.toThrow('cannot restart')
    const late = new FakeWire()
    h.transport.attachWire(late)
    expect(late.destroyed).toBe(true)
    await h.transport.stop()
  })

  it('rejects deliveries that were already awaiting an ack', async () => {
    const wires: FakeWire[] = []
    const h = lanHarness({ requestTimeoutMs: 60000 }, async () => {
      const wire = new FakeWire()
      wires.push(wire)
      return wire
    })
    await h.transport.start()
    discoverySocket(h).emitMessage(encodeFrame(announce('p1', 43001)), { address: '10.0.0.9', port: 42000 })
    const pending = h.transport.deliver(peer('p1'), { messageId: mid('m1'), text: 'hello', sentAt: 7 })
    await vi.waitFor(() => {
      expect(wires.at(0)?.sent).toHaveLength(1)
    })
    await h.transport.stop()
    const error = await failure(pending)
    expect(error.code).toBe('closed')
    expect(error.message).toContain('stopped before the peer acked')
    expect(wires.at(0)?.destroyed).toBe(true)
  })

  it('refuses new deliveries once stopped', async () => {
    const h = lanHarness({}, async () => new FakeWire())
    await h.transport.start()
    discoverySocket(h).emitMessage(encodeFrame(announce('p1', 43001)), { address: '10.0.0.9', port: 42000 })
    await h.transport.stop()
    const error = await failure(h.transport.deliver(peer('p1'), { messageId: mid('m1'), text: 'x', sentAt: 1 }))
    expect(error.code).toBe('closed')
  })

  it('tears down unbound wires as well', async () => {
    const h = lanHarness()
    await h.transport.start()
    const unbound = new FakeWire()
    serveConnection(h, unbound)
    await h.transport.stop()
    expect(unbound.destroyed).toBe(true)
  })

  it('stays tolerant of double stop', async () => {
    const h = lanHarness()
    await h.transport.start()
    await h.transport.stop()
    await expect(h.transport.stop()).resolves.toBeUndefined()
  })
})

describe('plugin wiring', () => {
  const homes: { ctx: Context }[] = []

  afterEach(async () => {
    const remaining = [...homes]
    homes.length = 0
    for (const home of remaining) await home.ctx.fiber.dispose()
  })

  async function chatHome(displayName: string, lan: ChatLanConfig): Promise<{
    ctx: Context
    chat: ChatRuntime
    id: PeerId
  }> {
    const ctx = new Context()
    try {
      await ctx.plugin(Storage)
      ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
      const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
      ctx.storage.mount('domain', facility)
      ctx.provide('storageDomain', facility)
      ctx.provide('agents', { roots: () => [] } as never)
      ctx.provide('sessionProjections', { register: () => () => {}, stateOf: () => undefined } as never)
      await ctx.plugin(ChatRuntime, { displayName })
      await ctx.plugin(ChatLan, {
        bindAddress: '127.0.0.1',
        discoveryPort: 0,
        transportPort: 0,
        presenceIntervalMs: 50,
        presenceTtlMs: 400,
        requestTimeoutMs: 1500,
        broadcastAddress: '127.0.0.1',
        ...lan,
      })
      return { ctx, chat: ctx.chat, id: ctx.chat.identity.peerId }
    } catch (error) {
      await ctx.fiber.dispose()
      throw error
    }
  }

  async function paired(home: { ctx: Context; chat: ChatRuntime }, peerId: PeerId): Promise<void> {
    if (home.chat.listFriends().some(friend => friend.record.peerId === peerId)) return
    await new Promise<void>((resolve) => {
      home.ctx.on('chat/friend-changed', (event) => {
        if (event.peerId === peerId && event.operation === 'added') resolve()
      })
    })
  }

  it('stays transport-less when disabled', async () => {
    const home = await chatHome('alice', { enabled: false })
    homes.push(home)
    expect(home.ctx.chatLan.transport).toBeUndefined()
    expect((await failure(home.chat.requestPairing(peer('nobody')))).code).toBe('transport-unavailable')
  })

  it('overrides the identity display name at boot', async () => {
    const home = await chatHome('alice', { displayName: 'Custom Alice' })
    homes.push(home)
    expect(home.chat.identity.displayName).toBe('Custom Alice')
  })

  it('mounts a live transport and tears down cleanly', async () => {
    const home = await chatHome('alice', {})
    const transport = home.ctx.chatLan.transport
    if (transport === undefined) throw new Error('lan transport missing')
    expect(transport.discoveryPort).toBeGreaterThan(0)
    expect(transport.servingPort).toBeGreaterThan(0)
    await home.ctx.fiber.dispose()
  })

  it('pairs and chats between two loopback instances', async () => {
    const alice = await chatHome('alice', {})
    homes.push(alice)
    const aliceTransport = alice.ctx.chatLan.transport
    if (aliceTransport === undefined) throw new Error('alice lan transport missing')
    const bob = await chatHome('bob', { directPeers: [`127.0.0.1:${aliceTransport.discoveryPort}`] })
    homes.push(bob)

    await vi.waitFor(() => {
      expect(alice.chat.listDiscoveredPeers().map(entry => entry.peerId)).toEqual([bob.id])
      expect(bob.chat.listDiscoveredPeers().map(entry => entry.peerId)).toEqual([alice.id])
    }, 5000)

    await alice.chat.requestPairing(bob.id)
    await vi.waitFor(() => {
      expect(bob.chat.listPendingPairings()).toHaveLength(1)
    }, 5000)
    const [pendingPairing] = bob.chat.listPendingPairings()
    if (pendingPairing === undefined) throw new Error('bob never saw the pairing request')
    expect(pendingPairing).toMatchObject({ peerId: alice.id, direction: 'incoming' })
    await bob.chat.respondPairing(alice.id, true)
    await paired(alice, bob.id)

    const [aliceFriend] = alice.chat.listFriends()
    const [bobFriend] = bob.chat.listFriends()
    if (aliceFriend === undefined || bobFriend === undefined) throw new Error('pairing did not land on both sides')
    expect(aliceFriend.record.fingerprint).toBe(bobFriend.record.fingerprint)
    expect(aliceFriend.online).toBe(true)

    const sent = await alice.chat.send(bob.id, 'hello bob')
    expect(sent.text).toBe('hello bob')
    await vi.waitFor(() => {
      expect(bob.chat.messages(alice.id).map(record => record.text)).toEqual(['hello bob'])
    })
    await bob.chat.send(alice.id, 'hi alice')
    await vi.waitFor(() => {
      expect(alice.chat.messages(bob.id).map(record => record.text).sort()).toEqual(['hello bob', 'hi alice'])
    })

    homes.splice(homes.indexOf(bob), 1)
    await bob.ctx.fiber.dispose()
    await vi.waitFor(() => {
      expect(alice.chat.listDiscoveredPeers()).toEqual([])
    }, 5000)
    const [offline] = alice.chat.listFriends()
    if (offline === undefined) throw new Error('alice lost her friend record')
    expect(offline.online).toBe(false)
    expect((await failure(alice.chat.send(bob.id, 'anyone there?'))).code).toBe('peer-unknown')
  }, 30000)

  it('maps connection-refused dials to peer-offline over real sockets', async () => {
    const probe = createServer()
    await new Promise<void>((resolve) => {
      probe.listen(0, '127.0.0.1', () => { resolve() })
    })
    const deadPort = (probe.address() as { port: number }).port
    await new Promise<void>((resolve) => {
      probe.close(() => { resolve() })
    })
    const transport = new LanTransport({
      self: () => SELF,
      config: resolveLanConfig({
        bindAddress: '127.0.0.1',
        discoveryPort: 0,
        transportPort: 0,
        presenceIntervalMs: 5000,
        presenceTtlMs: 60000,
        requestTimeoutMs: 1000,
        broadcastAddress: '127.0.0.1',
      }),
      host: recordingHost(),
      warn: () => {},
    })
    try {
      await transport.start()
      await announceOverUdp(transport, 'ghost', deadPort)
      await vi.waitFor(() => {
        expect(transport.isReachable(peer('ghost'))).toBe(true)
      }, 5000)
      const error = await failure(transport.deliver(peer('ghost'), { messageId: mid('m1'), text: 'x', sentAt: 1 }))
      expect(error.code).toBe('peer-offline')
      expect(error.message).toContain('dialing peer')
    } finally {
      await transport.stop()
    }
  }, 15000)

  it('receives a real datagram through the dgram adapter', async () => {
    const host = recordingHost()
    const transport = new LanTransport({
      self: () => SELF,
      config: resolveLanConfig({
        bindAddress: '127.0.0.1',
        discoveryPort: 0,
        transportPort: 0,
        presenceIntervalMs: 5000,
        presenceTtlMs: 60000,
        broadcastAddress: '127.0.0.1',
      }),
      host,
      warn: () => {},
    })
    try {
      await transport.start()
      expect(transport.servingPort).toBeGreaterThan(0)
      await announceOverUdp(transport, 'ghost', transport.servingPort)
      await vi.waitFor(() => {
        expect(host.discovered).toEqual([{ peerId: peer('ghost'), displayName: 'Ghost' }])
      }, 5000)
      expect(transport.isReachable(peer('ghost'))).toBe(true)
    } finally {
      await transport.stop()
    }
  }, 15000)

  it('surfaces async discovery send failures as warnings', async () => {
    const probe = createSocket('udp4')
    const freePort = await new Promise<number>((resolve) => {
      probe.bind(0, '127.0.0.1', () => { resolve(probe.address().port) })
    })
    await new Promise<void>((resolve) => {
      probe.close(() => { resolve() })
    })
    const warns: string[] = []
    const transport = new LanTransport({
      self: () => SELF,
      config: resolveLanConfig({
        bindAddress: '127.0.0.1',
        discoveryPort: freePort,
        transportPort: 0,
        presenceIntervalMs: 20,
        broadcastAddress: '300.0.0.1',
      }),
      host: recordingHost(),
      warn: (message) => { warns.push(message) },
    })
    try {
      await transport.start()
      await vi.waitFor(() => {
        expect(warns.some(message => message.includes('discovery socket error'))).toBe(true)
      }, 5000)
    } finally {
      await transport.stop()
    }
  }, 15000)

  it('fails loudly when the discovery bind is unavailable', async () => {
    const transport = new LanTransport({
      self: () => SELF,
      config: resolveLanConfig({ bindAddress: '203.0.113.1', discoveryPort: 0, transportPort: 0 }),
      host: recordingHost(),
      warn: () => {},
    })
    await expect(transport.start()).rejects.toThrow()
  }, 15000)

  it('fails loudly when the transport port is already taken', async () => {
    const probe = createServer()
    await new Promise<void>((resolve) => {
      probe.listen(0, '127.0.0.1', () => { resolve() })
    })
    const port = (probe.address() as { port: number }).port
    await new Promise<void>((resolve) => {
      probe.close(() => { resolve() })
    })
    const first = new LanTransport({
      self: () => SELF,
      config: resolveLanConfig({ bindAddress: '127.0.0.1', discoveryPort: 0, transportPort: port, presenceIntervalMs: 5000 }),
      host: recordingHost(),
      warn: () => {},
    })
    const second = new LanTransport({
      self: () => SELF,
      config: resolveLanConfig({ bindAddress: '127.0.0.1', discoveryPort: 0, transportPort: port }),
      host: recordingHost(),
      warn: () => {},
    })
    try {
      await first.start()
      await expect(second.start()).rejects.toThrow()
    } finally {
      await first.stop()
    }
  }, 15000)
})

/** Feed one announce frame into a transport's real discovery port from a throwaway UDP socket. */
async function announceOverUdp(transport: LanTransport, peerId: string, tcpPort: number): Promise<void> {
  const sender = createSocket('udp4')
  await new Promise<void>((resolve) => {
    sender.bind(0, '127.0.0.1', () => { resolve() })
  })
  await new Promise<void>((resolve, reject) => {
    sender.send(encodeFrame(announce(peerId, tcpPort, 'Ghost')), transport.discoveryPort, '127.0.0.1', (error) => {
      if (error === null) resolve()
      else reject(error)
    })
  })
  await new Promise<void>((resolve) => {
    sender.close(() => { resolve() })
  })
}
