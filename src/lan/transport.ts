/**
 * The LAN chat transport: UDP datagram announcements for discovery and
 * presence, TCP JSON-lines connections for pairing, message delivery, and
 * acks. Presence is announcement-driven — a peer stays discovered while its
 * announcements keep arriving inside the TTL, and expiry drops it. Delivery
 * resolves on the recipient's ack frame; refused, timed-out, and undialable
 * sends surface as `ChatError`s and persist nothing upstream.
 *
 * All platform sockets enter through the injectable `discovery`, `serve`, and
 * `dial` factories, so the frame logic tests without real networking; the
 * default factories wrap `node:dgram` and `node:net`.
 * @module @deepseek-ai/dsh-chat-lan/transport
 */

import { createSocket } from 'node:dgram'
import { connect, createServer, type Socket } from 'node:net'
import { ChatError } from '@deepseek-ai/dsh-chat'
import type { ChatIdentity, ChatTransport, ChatTransportHost, InboundChatMessage, PeerId } from '@deepseek-ai/dsh-chat'
import type { DirectPeerTarget, LanConfig } from './config.ts'
import { parseDirectPeer } from './config.ts'
import { decodeFrame, encodeFrame, PROTOCOL_VERSION } from './protocol.ts'
import type { AckFrame, AnnounceFrame, LanFrame, MessageFrame } from './protocol.ts'

/** One remote endpoint, as the discovery layer and dialer exchange it. */
export interface WireEndpoint {
  readonly address: string
  readonly port: number
}

/** The socket events the transport subscribes to. */
export type WireEvent = 'connect' | 'error' | 'close' | 'data'

/**
 * Minimal socket surface the transport drives. `net.Socket` satisfies it; the
 * transport only relies on these members, so tests can fake connections.
 */
export interface WireSocket {
  write(payload: string): boolean
  destroy(): void
  readonly destroyed: boolean
  readonly remoteAddress: string | undefined
  setNoDelay?(): void
  on(event: WireEvent, listener: (...args: unknown[]) => void): this
  removeListener(event: WireEvent, listener: (...args: unknown[]) => void): this
}

/** Message and error callbacks a discovery socket feeds back into the transport. */
export interface DiscoveryHandlers {
  onMessage(payload: string, from: WireEndpoint): void
  onError(error: Error): void
}

/** Bindable UDP announcement socket; production wraps `node:dgram`, tests fake it. */
export interface DiscoverySocket {
  bind(port: number, address: string): Promise<void>
  /** The bound endpoint; valid after {@link DiscoverySocket.bind} resolves. */
  endpoint(): WireEndpoint
  send(payload: string, port: number, address: string): void
  close(): Promise<void>
}

/**
 * Build the UDP announcement socket for one bind request.
 * @param port - configured discovery port; `0` binds ephemeral.
 * @param address - configured local bind address.
 * @param handlers - message and error callbacks the socket feeds back.
 * @returns the socket, unbound until its own `bind` resolves.
 */
export type DiscoveryFactory = (port: number, address: string, handlers: DiscoveryHandlers) => DiscoverySocket

/** A live TCP listener feeding inbound connections to the transport. */
export interface ServeHandle {
  readonly port: number
  close(): Promise<void>
}

/**
 * Start the TCP listener that serves inbound frames.
 * @param port - configured transport port; `0` serves ephemeral.
 * @param address - configured local bind address.
 * @param onConnection - receives each accepted connection.
 * @returns the handle for the live listener.
 */
export type ServeFactory = (port: number, address: string, onConnection: (wire: WireSocket) => void) => Promise<ServeHandle>

/**
 * Open one outbound connection.
 * @param port - the peer's served TCP port, as announced.
 * @param address - the peer's address, as observed by discovery.
 * @returns the connected socket.
 */
export type DialFactory = (port: number, address: string) => Promise<WireSocket>

/** Everything one `LanTransport` needs: identity, resolved config, host callbacks, and optional test seams. */
export interface LanTransportOptions {
  /** The local chat identity, read live so display-name changes propagate. */
  readonly self: () => ChatIdentity
  readonly config: LanConfig
  readonly host: ChatTransportHost
  readonly warn: (message: string) => void
  readonly discovery?: DiscoveryFactory
  readonly serve?: ServeFactory
  readonly dial?: DialFactory
  /** Injectable clock for presence bookkeeping. */
  readonly now?: () => number
}

interface PeerEntry {
  readonly peerId: PeerId
  readonly displayName: string
  readonly address: string
  readonly tcpPort: number
  readonly lastSeen: number
}

interface PendingAck {
  resolve(): void
  reject(error: ChatError): void
  readonly timer: ReturnType<typeof setTimeout>
}

/** One JSON line may not exceed this; larger lines mean a broken peer and drop the connection. */
const MAX_FRAME_BYTES = 65536

/** The LAN transport registered into `ctx.chat`: discovery, pairing, delivery. */
export class LanTransport implements ChatTransport {
  readonly name: string = 'lan'

  private readonly options: LanTransportOptions
  private readonly config: LanConfig
  private readonly targets: readonly DirectPeerTarget[]
  private discovery: DiscoverySocket | undefined
  private listener: ServeHandle | undefined
  private presenceTimer: ReturnType<typeof setInterval> | undefined
  private readonly peers = new Map<PeerId, PeerEntry>()
  private readonly wirePeer = new Map<WireSocket, PeerId>()
  private readonly peerWire = new Map<PeerId, WireSocket>()
  private readonly buffers = new Map<WireSocket, string>()
  private readonly attached = new Set<WireSocket>()
  private readonly awaiting = new Map<string, PendingAck>()
  private staleVersionCountValue = 0
  private stopped = false

  constructor(options: LanTransportOptions) {
    this.options = options
    this.config = options.config
    this.targets = options.config.directPeers.flatMap((raw) => {
      const target = parseDirectPeer(raw)
      if (target === undefined) {
        options.warn(`ignoring directPeers entry "${raw}" (expected host:port)`)
        return []
      }
      return [target]
    })
  }

  /** The actually bound discovery port (differs from config when ephemeral). */
  get discoveryPort(): number {
    return this.discovery?.endpoint().port ?? 0
  }

  /** The actually served TCP port (0 before start). */
  get servingPort(): number {
    return this.listener?.port ?? 0
  }

  /** How many frames arrived with a foreign protocol version and were dropped. */
  get staleVersionCount(): number {
    return this.staleVersionCountValue
  }

  async start(): Promise<void> {
    if (this.stopped) throw new ChatError('closed', 'dsh-chat-lan: transport is stopped and cannot restart')
    const discovery = this.discoveryFactory(this.config.discoveryPort, this.config.bindAddress, {
      onMessage: (payload, from) => { this.onDatagram(payload, from) },
      onError: (error) => { this.options.warn(`discovery socket error: ${error.message}`) },
    })
    this.discovery = discovery
    try {
      await discovery.bind(this.config.discoveryPort, this.config.bindAddress)
    } catch (error) {
      this.discovery = undefined
      await discovery.close()
      throw error
    }
    try {
      this.listener = await this.serveFactory(this.config.transportPort, this.config.bindAddress, (wire) => {
        this.attachWire(wire)
      })
    } catch (error) {
      this.discovery = undefined
      await discovery.close()
      throw error
    }
    this.presenceTimer = setInterval(() => { this.tick() }, this.config.presenceIntervalMs)
    this.presenceTimer.unref()
    this.announceAll()
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    if (this.presenceTimer !== undefined) clearInterval(this.presenceTimer)
    this.presenceTimer = undefined
    for (const wire of [...this.attached]) this.dropWire(wire)
    for (const [messageId, pending] of [...this.awaiting]) {
      clearTimeout(pending.timer)
      this.awaiting.delete(messageId)
      pending.reject(new ChatError('closed', 'dsh-chat-lan: transport stopped before the peer acked'))
    }
    const listener = this.listener
    this.listener = undefined
    const discovery = this.discovery
    this.discovery = undefined
    if (listener !== undefined) await listener.close()
    if (discovery !== undefined) await discovery.close()
    this.peers.clear()
  }

  isReachable(peerId: PeerId): boolean {
    return !this.stopped && this.peers.has(peerId)
  }

  async deliver(peerId: PeerId, message: InboundChatMessage): Promise<void> {
    const wire = await this.ensureWire(peerId)
    await this.requestAck(wire, peerId, message)
  }

  async transmitPairingRequest(peerId: PeerId): Promise<void> {
    const wire = await this.ensureWire(peerId)
    this.sendFrame(wire, {
      v: PROTOCOL_VERSION,
      kind: 'pair-request',
      peerId: this.selfId,
      displayName: this.options.self().displayName,
    })
  }

  async transmitPairingResponse(peerId: PeerId, accept: boolean): Promise<void> {
    const wire = await this.ensureWire(peerId)
    this.sendFrame(wire, { v: PROTOCOL_VERSION, kind: 'pair-response', peerId: this.selfId, accept })
  }

  /**
   * Bind one connection into the transport; used by the serve factory and by dial.
   * @param wire - the accepted or dialed connection to attach.
   */
  attachWire(wire: WireSocket): void {
    if (this.stopped) {
      wire.destroy()
      return
    }
    wire.setNoDelay?.()
    this.buffers.set(wire, '')
    this.attached.add(wire)
    wire.on('data', (...args: unknown[]) => { this.onWireData(wire, args[0]) })
    wire.on('error', (...args: unknown[]) => {
      const error = args[0]
      this.options.warn(`connection error${error instanceof Error ? `: ${error.message}` : ''}`)
    })
    wire.on('close', () => { this.dropWire(wire) })
  }

  private get selfId(): PeerId {
    return this.options.self().peerId
  }

  private get discoveryFactory(): DiscoveryFactory {
    return this.options.discovery ?? discoverWithDgram
  }

  private get serveFactory(): ServeFactory {
    return this.options.serve ?? serveWithNet
  }

  private get dialFactory(): DialFactory {
    return this.options.dial ?? dialWithNet
  }

  private tick(): void {
    const now = this.now()
    for (const [peerId, entry] of [...this.peers]) {
      if (now - entry.lastSeen <= this.config.presenceTtlMs) continue
      this.peers.delete(peerId)
      this.options.host.onPeerExpired(peerId)
    }
    this.announceAll()
  }

  private announceAll(): void {
    this.sendAnnounce(this.config.discoveryPort, this.config.broadcastAddress)
    for (const target of this.targets) this.sendAnnounce(target.port, target.host)
  }

  private sendAnnounce(port: number, address: string): void {
    const frame: AnnounceFrame = {
      v: PROTOCOL_VERSION,
      kind: 'announce',
      peerId: this.selfId,
      displayName: this.options.self().displayName,
      tcpPort: this.servingPort,
    }
    this.discovery?.send(encodeFrame(frame), port, address)
  }

  private onDatagram(payload: string, from: WireEndpoint): void {
    const decoded = decodeFrame(payload)
    if (decoded === 'stale-version') {
      this.countStaleVersion()
      return
    }
    if (decoded === 'malformed') {
      this.options.warn(`ignoring malformed datagram from ${from.address}:${from.port}`)
      return
    }
    if (decoded.kind !== 'announce') return
    if (decoded.peerId === this.selfId) return
    this.onAnnounce(decoded, from)
  }

  private countStaleVersion(): void {
    this.staleVersionCountValue += 1
    if (this.staleVersionCountValue === 1) this.options.warn('ignoring frames with a different protocol version')
  }

  private onAnnounce(frame: AnnounceFrame, replyTo: WireEndpoint | undefined): void {
    const now = this.now()
    const known = this.peers.get(frame.peerId)
    this.peers.set(frame.peerId, {
      peerId: frame.peerId,
      displayName: frame.displayName,
      address: replyTo?.address ?? known?.address ?? '',
      tcpPort: frame.tcpPort,
      lastSeen: now,
    })
    this.options.host.onPeerDiscovered({ peerId: frame.peerId, displayName: frame.displayName })
    if (replyTo === undefined) return
    if (known === undefined || now - known.lastSeen > this.config.presenceIntervalMs) {
      this.sendAnnounce(replyTo.port, replyTo.address)
    }
  }

  private onWireData(wire: WireSocket, chunk: unknown): void {
    const previous = this.buffers.get(wire)
    if (previous === undefined) return
    let buffer = previous
    buffer += typeof chunk === 'string' ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk).toString('utf8') : ''
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline < 0) break
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.length > MAX_FRAME_BYTES) {
        this.options.warn(`dropping a connection that sent a ${line.length}-byte frame`)
        this.dropWire(wire)
        return
      }
      if (line.length > 0) this.handleLine(wire, line)
    }
    this.buffers.set(wire, buffer)
  }

  private handleLine(wire: WireSocket, line: string): void {
    const decoded = decodeFrame(line)
    if (decoded === 'stale-version') {
      this.countStaleVersion()
      return
    }
    if (decoded === 'malformed') {
      this.options.warn('ignoring a malformed frame on a chat connection')
      return
    }
    if (decoded.peerId === this.selfId) return
    const bound = this.wirePeer.get(wire)
    if (bound !== undefined && bound !== decoded.peerId) {
      this.options.warn('ignoring a frame whose sender does not match the connection identity')
      return
    }
    this.wirePeer.set(wire, decoded.peerId)
    this.peerWire.set(decoded.peerId, wire)
    switch (decoded.kind) {
      case 'announce':
        this.onAnnounce(decoded, undefined)
        return
      case 'pair-request':
        this.touch(decoded.peerId, decoded.displayName, wire)
        this.options.host.onPairingRequest({ peerId: decoded.peerId, displayName: decoded.displayName })
        return
      case 'pair-response':
        this.touch(decoded.peerId, undefined, wire)
        this.options.host.onPairingResponse(decoded.peerId, decoded.accept)
        return
      case 'message':
        this.touch(decoded.peerId, undefined, wire)
        this.receiveMessage(wire, decoded)
        return
      case 'ack':
        this.receiveAck(decoded)
        return
    }
  }

  private touch(peerId: PeerId, displayName: string | undefined, wire: WireSocket): void {
    const known = this.peers.get(peerId)
    this.peers.set(peerId, {
      peerId,
      displayName: displayName ?? known?.displayName ?? '',
      address: known?.address ?? wire.remoteAddress ?? '',
      tcpPort: known?.tcpPort ?? 0,
      lastSeen: this.now(),
    })
  }

  private receiveMessage(wire: WireSocket, frame: MessageFrame): void {
    void this.options.host
      .onMessage(frame.peerId, { messageId: frame.messageId, text: frame.text, sentAt: frame.sentAt })
      .then(accepted => ({ accepted }), () => ({ accepted: false }))
      .then(({ accepted }) => {
        this.sendFrame(wire, {
          v: PROTOCOL_VERSION,
          kind: 'ack',
          peerId: this.selfId,
          messageId: frame.messageId,
          accepted,
        })
      })
      .catch((error: unknown) => {
        this.options.warn(`writing the ack for message ${frame.messageId} failed: ${String(error)}`)
      })
  }

  private receiveAck(frame: AckFrame): void {
    const pending = this.awaiting.get(frame.messageId)
    if (pending === undefined) {
      this.options.warn(`ignoring an ack for unknown message ${frame.messageId}`)
      return
    }
    clearTimeout(pending.timer)
    this.awaiting.delete(frame.messageId)
    if (frame.accepted) pending.resolve()
    else pending.reject(new ChatError('not-paired', `peer ${frame.peerId} refused message ${frame.messageId}`))
  }

  private async ensureWire(peerId: PeerId): Promise<WireSocket> {
    if (this.isStopped()) throw new ChatError('closed', 'dsh-chat-lan: transport is stopped')
    const existing = this.peerWire.get(peerId)
    if (existing !== undefined && !existing.destroyed) return existing
    const entry = this.peers.get(peerId)
    if (entry === undefined) throw new ChatError('peer-unknown', `peer ${peerId} has not been discovered`)
    if (entry.tcpPort <= 0 || entry.address.length === 0) {
      throw new ChatError('peer-offline', `peer ${peerId} has no known TCP endpoint`)
    }
    let wire: WireSocket
    try {
      wire = await this.dialWire(entry)
    } catch (error) {
      if (error instanceof ChatError) throw error
      throw new ChatError('peer-offline', `dialing peer ${peerId} failed: ${String(error)}`)
    }
    if (this.isStopped()) {
      wire.destroy()
      throw new ChatError('closed', 'dsh-chat-lan: transport is stopped')
    }
    this.attachWire(wire)
    this.wirePeer.set(wire, peerId)
    this.peerWire.set(peerId, wire)
    return wire
  }

  /** Read the stop flag through a call so control-flow narrowing cannot skip the post-dial check. */
  private isStopped(): boolean {
    return this.stopped
  }

  private dialWire(entry: PeerEntry): Promise<WireSocket> {
    return new Promise<WireSocket>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        settled = true
        reject(new ChatError('peer-offline', `dialing ${entry.address}:${entry.tcpPort} timed out`))
      }, this.config.requestTimeoutMs)
      timer.unref()
      void this.dialFactory(entry.tcpPort, entry.address).then(
        (wire) => {
          if (settled) {
            wire.destroy()
            return
          }
          settled = true
          clearTimeout(timer)
          resolve(wire)
        },
        (error: unknown) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(error instanceof ChatError ? error : new Error(String(error)))
        },
      )
    })
  }

  private requestAck(wire: WireSocket, peerId: PeerId, message: InboundChatMessage): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.awaiting.delete(message.messageId)
        this.dropWire(wire)
        reject(new ChatError('peer-offline', `peer ${peerId} did not ack message ${message.messageId} within ${this.config.requestTimeoutMs}ms`))
      }, this.config.requestTimeoutMs)
      timer.unref()
      this.awaiting.set(message.messageId, { resolve, reject, timer })
      try {
        this.sendFrame(wire, {
          v: PROTOCOL_VERSION,
          kind: 'message',
          peerId: this.selfId,
          messageId: message.messageId,
          text: message.text,
          sentAt: message.sentAt,
        })
      } catch (error) {
        clearTimeout(timer)
        this.awaiting.delete(message.messageId)
        throw error
      }
    })
  }

  private sendFrame(wire: WireSocket, frame: LanFrame): void {
    if (wire.destroyed) throw new ChatError('peer-offline', 'dsh-chat-lan: connection already closed')
    wire.write(encodeFrame(frame))
  }

  private dropWire(wire: WireSocket): void {
    this.buffers.delete(wire)
    this.attached.delete(wire)
    const peerId = this.wirePeer.get(wire)
    this.wirePeer.delete(wire)
    if (peerId !== undefined && this.peerWire.get(peerId) === wire) this.peerWire.delete(peerId)
    if (!wire.destroyed) wire.destroy()
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }
}

function toWire(socket: Socket): WireSocket {
  return socket
}

const discoverWithDgram: DiscoveryFactory = (_port, _address, handlers) => {
  const socket = createSocket('udp4')
  socket.on('message', (chunk, rinfo) => {
    handlers.onMessage(chunk.toString('utf8'), { address: rinfo.address, port: rinfo.port })
  })
  socket.on('error', (error) => { handlers.onError(error) })
  return {
    bind: (boundPort, boundAddress) => new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        socket.removeListener('error', onError)
        reject(error)
      }
      socket.once('error', onError)
      socket.bind(boundPort, boundAddress, () => {
        socket.removeListener('error', onError)
        socket.setBroadcast(true)
        resolve()
      })
    }),
    endpoint: () => {
      const local = socket.address()
      return { address: local.address, port: local.port }
    },
    send: (payload, target, host) => {
      try {
        socket.send(payload, target, host, (error) => {
          if (error !== null) handlers.onError(error)
        })
      } catch (error) {
        /* v8 ignore next -- dgram only throws Error subclasses synchronously; the non-Error wrap is defensive */
        handlers.onError(error instanceof Error ? error : new Error(String(error)))
      }
    },
    close: () => new Promise<void>((resolve) => {
      socket.close(() => { resolve() })
    }),
  }
}

const serveWithNet: ServeFactory = (port, address, onConnection) => new Promise<ServeHandle>((resolve, reject) => {
  const server = createServer((socket) => {
    socket.setNoDelay(true)
    onConnection(toWire(socket))
  })
  const onError = (error: Error): void => {
    server.removeListener('error', onError)
    reject(error)
  }
  server.once('error', onError)
  server.listen(port, address, () => {
    server.removeListener('error', onError)
    const local = server.address() as { port: number }
    resolve({
      port: local.port,
      close: () => new Promise<void>((done) => {
        server.close(() => { done() })
      }),
    })
  })
})

const dialWithNet: DialFactory = (port, address) => new Promise<WireSocket>((resolve, reject) => {
  const socket = connect(port, address)
  socket.setNoDelay(true)
  const onConnect = (): void => {
    socket.removeListener('connect', onConnect)
    socket.removeListener('error', onConnectError)
    resolve(toWire(socket))
  }
  const onConnectError = (error: Error): void => {
    socket.removeListener('connect', onConnect)
    socket.removeListener('error', onConnectError)
    reject(error)
  }
  socket.once('connect', onConnect)
  socket.once('error', onConnectError)
})
