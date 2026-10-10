/**
 * The chat capability seam (`ctx.chat`): this harness home's stable peer
 * identity, the durable friend and message records in the `chat` storage
 * domain, the pairing state machine, and the single-slot transport registry.
 * A transport plugin (`@deepseek-ai/dsh-chat-lan` today) owns the wire and
 * reports peer facts through the {@link ChatTransportHost} callbacks; model
 * tools, slash commands, the Remote controller, and the Web panel are all
 * consumers of this one service.
 *
 * Only delivered messages are durable: an outbound send persists after the
 * peer's ack, an inbound message persists before its ack is resolved, and a
 * failed send persists nothing. Inbound messages surface to agents according
 * to the `injectInto` config: the most recently active root agent receives
 * the message as `agent.inject()` context, which lands in the session log as
 * a `user/message` with source `{ kind: 'chat', form: 'relay' }`.
 * @module @deepseek-ai/dsh-chat
 */

import { hostname } from 'node:os'
import { Context, Service } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { chatActivityProjectionDefinition } from './activity-projection.ts'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Relayed inbound friend chat.
     * @persistenceAttribution
     */
    'chat': { kind: 'chat' }
  }
}

import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { chatDomainSpec, IDENTITY_KEY } from './domain.ts'
import { ChatError } from './error.ts'
import { pairingFingerprint } from './fingerprint.ts'
import type { ChatMessageId, PeerId } from './brand.ts'
import type {
  ChatIdentity,
  ChatMessageRecord,
  ChatTransport,
  ChatTransportHost,
  DiscoveredPeer,
  FriendRecord,
  FriendView,
  InboundChatMessage,
  PairingDirection,
  PairingOperation,
  PairingRequestRecord,
  PeerAnnouncement,
} from './types.ts'

export type * from './brand.ts'
export type * from './error.ts'
export type * from './types.ts'
export { ChatError } from './error.ts'
export { CHAT_DOMAIN_VERSION, chatDomainSpec, IDENTITY_KEY } from './domain.ts'
export { pairingFingerprint } from './fingerprint.ts'

/** Default read window of {@link ChatRuntime.messages}. */
export const DEFAULT_MESSAGE_LIMIT = 200

/** Display-name policy: trimmed, non-empty, at most 64 UTF-16 code units. */
const DISPLAY_NAME_MAX_CHARS = 64

/** Config default; mirrored by the schemastery schema's own default. */
const DEFAULT_INJECT_INTO: 'latest' | 'none' = 'latest'

/** Config default; mirrored by the schemastery schema's own default. */
const DEFAULT_MAX_MESSAGE_CHARS = 4000

declare module '@deepseek-ai/cordis' {
  interface Context {
    chat: ChatRuntime
  }
  interface Events {
    /**
     * One message became durable in this home's log. Outbound records emit
     * after the peer's delivery ack; inbound records emit after their own
     * durability, just before the delivery ack resolves.
     * @param payload.message - the stored record (direction tells the sides).
     * @mode emit
     */
    'chat/message'(payload: { readonly message: ChatMessageRecord }): void
    /**
     * The friend set or one friend's local record changed.
     * @param payload.peerId - the friend the operation applies to.
     * @param payload.operation - what happened: `added`, `removed`, or `renamed`.
     * @mode emit
     */
    'chat/friend-changed'(payload: { readonly peerId: PeerId; readonly operation: 'added' | 'removed' | 'renamed' }): void
    /**
     * The pairing state machine moved. Pending pairings are process-local, so
     * consumers treat `requested` as "show a prompt until a terminal
     * operation for the same peer arrives".
     * @param payload.peerId - the other side of the pairing.
     * @param payload.displayName - the other side's display name, as last known.
     * @param payload.direction - which side created the request.
     * @param payload.operation - what happened: `requested`, `accepted`, `declined`, or `cancelled`.
     * @mode emit
     */
    'chat/pairing'(payload: {
      readonly peerId: PeerId
      readonly displayName: string
      readonly direction: PairingDirection
      readonly operation: PairingOperation
    }): void
    /**
     * A discovered peer entered or left the live set (first announcement,
     * display-name change, or expiry). Per-announcement refreshes do not emit.
     * @param payload.peerId - the peer whose presence changed.
     * @param payload.online - whether the peer is now considered reachable.
     * @mode emit
     */
    'chat/presence'(payload: { readonly peerId: PeerId; readonly online: boolean }): void
  }
}

/** Validated service config; every field is a deployment-varying choice. */
export interface ChatConfig {
  /**
   * Where inbound friend messages surface to agents: `'latest'` injects each
   * message into the most recently active root agent as model-facing context;
   * `'none'` disables injection (tools and the UI still see messages).
   */
  readonly injectInto?: 'latest' | 'none'
  /** Maximum accepted message length in UTF-16 code units, both directions. */
  readonly maxMessageChars?: number
  /**
   * Deployment-owned display name. When set, it overrides the stored name on
   * every boot; when absent, the stored name (possibly changed via
   * `setDisplayName`) is kept.
   */
  readonly displayName?: string
}

/** One discovered peer entry as the runtime tracks it. */
interface DiscoveredEntry {
  displayName: string
  transport: string
  lastSeen: number
}

/**
 * `ctx.chat`: identity, pairing, the durable message log, and the transport
 * registration. See the module docs for the capability overview.
 */
export class ChatRuntime extends Service {
  static inject = ['agents', 'storageDomain', 'sessionProjections']

  static Config: s<ChatConfig> = s.object({
    injectInto: s.union(['latest', 'none']).default(DEFAULT_INJECT_INTO),
    maxMessageChars: s.number().step(1).min(1).default(DEFAULT_MAX_MESSAGE_CHARS),
    displayName: s.string(),
  })

  /** Validated config values. */
  private readonly injectInto: 'latest' | 'none'
  private readonly maxMessageChars: number
  private readonly displayNameOverride: string | undefined

  private metaTable?: KvTable<string, ChatIdentity>
  private friendsTable?: KvTable<FriendRecord['peerId'], FriendRecord>
  private messagesTable?: KvTable<ChatMessageRecord['messageId'], ChatMessageRecord>
  private identityValue?: ChatIdentity
  /** The transport host callbacks, created lazily once. */
  private hostValue?: ChatTransportHost

  /** Live peers as last announced, keyed by peer id. */
  private readonly discovered = new Map<PeerId, DiscoveredEntry>()
  /** Pending pairings, keyed by peer id; process-local by design. */
  private readonly pending = new Map<PeerId, PairingRequestRecord>()
  /** The registered transport, absent until one plugin claims the single slot. */
  private transport: ChatTransport | undefined
  /** True while a transport's `start` is in flight, rejecting a second registration. */
  private transportStarting = false

  constructor(ctx: Context, config: ChatConfig) {
    super(ctx, 'chat')
    this.injectInto = config.injectInto ?? DEFAULT_INJECT_INTO
    this.maxMessageChars = config.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS
    this.displayNameOverride = config.displayName
  }

  /** Open the domain, own its lifecycle, and bootstrap identity. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(chatDomainSpec)
    this.metaTable = domain.table('meta')
    this.friendsTable = domain.table('friends')
    this.messagesTable = domain.table('messages')
    this.ctx.effect(() => async () => {
      const transport = this.transport
      this.transport = undefined
      if (transport !== undefined) {
        try {
          await transport.stop()
        } catch (error) {
          this.ctx.logger.warn('dsh-chat: transport stop failed during teardown: %o', error)
        }
      }
      await domain.close()
    }, 'dsh-chat.close')
    this.ctx.effect(() => this.ctx.sessionProjections.register(chatActivityProjectionDefinition), 'dsh-chat.activity-projection')
    await this.bootstrapIdentity()
  }

  /** Read this home's chat identity (peer id and current display name). */
  get identity(): ChatIdentity {
    return this.requireIdentity()
  }

  /**
   * Register the home's chat transport. The seam holds exactly one transport;
   * a second registration is a composition bug and throws, including while a
   * first `start` is still in flight. A rejected `start` fails the
   * registering plugin loud and frees the slot again.
   * @param transport - the transport to claim the slot.
   * @returns resolution once the transport is serving.
   */
  async registerTransport(transport: ChatTransport): Promise<void> {
    if (this.transport !== undefined || this.transportStarting) {
      throw new Error('dsh-chat: a chat transport is already registered — the seam holds exactly one transport')
    }
    this.transportStarting = true
    try {
      await transport.start()
      this.transport = transport
    } finally {
      this.transportStarting = false
    }
  }

  /**
   * Replace this home's display name durably. Peers learn the new name on
   * their next announcement cycle, not retroactively.
   * @param name - the new display name.
   * @throws `ChatError` with `invalid-name` when the name is blank or over 64 characters.
   */
  async setDisplayName(name: string): Promise<void> {
    const meta = this.requireMeta()
    const displayName = this.resolveDisplayName(name)
    this.identityValue = { ...this.requireIdentity(), displayName }
    await meta.put(IDENTITY_KEY, this.identityValue)
  }

  /**
   * All accepted friends, each with the transport's live reachability belief.
   * @returns one view per stored friend record.
   */
  listFriends(): FriendView[] {
    const friends = this.requireFriends()
    return [...friends.entries()].map(([peerId, record]) => ({
      record,
      online: this.isOnline(peerId),
    }))
  }

  /**
   * Pending pairing requests, incoming and outgoing; process-local.
   * @returns one record per request still awaiting a decision.
   */
  listPendingPairings(): PairingRequestRecord[] {
    return [...this.pending.values()]
  }

  /**
   * Peers the transport currently sees on the wire, most recent announcement first.
   * @returns one entry per unexpired announcement.
   */
  listDiscoveredPeers(): DiscoveredPeer[] {
    return [...this.discovered.entries()]
      .map(([peerId, entry]) => ({
        peerId,
        displayName: entry.displayName,
        transport: entry.transport,
        lastSeen: entry.lastSeen,
      }))
      .sort((left, right) => right.lastSeen - left.lastSeen)
  }

  /**
   * Ask a discovered peer to pair. Creates an outgoing pending request and
   * transmits it; the pairing completes only when the peer accepts.
   * @param peerId - the peer to request.
   * @throws `ChatError` with `transport-unavailable` when no transport is registered,
   * `already-paired` when the peer is already a friend,
   * `pairing-pending` when any request with that peer is already pending, or
   * the transport's reachability codes (`peer-unknown`, `peer-offline`).
   */
  async requestPairing(peerId: PeerId): Promise<void> {
    const transport = this.requireTransport()
    const friends = this.requireFriends()
    if (friends.get(peerId) !== undefined) {
      throw new ChatError('already-paired', `peer ${peerId} is already a friend`)
    }
    if (this.pending.has(peerId)) {
      throw new ChatError('pairing-pending', `a pairing request with peer ${peerId} is already pending`)
    }
    const displayName = this.discovered.get(peerId)?.displayName ?? peerId
    const record: PairingRequestRecord = {
      peerId,
      displayName,
      direction: 'outgoing',
      requestedAt: Date.now(),
    }
    // Record before transmit so a fast response can never race the
    // bookkeeping; a transmit failure removes the request again.
    this.pending.set(peerId, record)
    try {
      await transport.transmitPairingRequest(peerId)
    } catch (cause) {
      this.pending.delete(peerId)
      throw cause
    }
    this.emitPairing(record, 'requested')
  }

  /**
   * Answer one incoming pairing request. Accepting stores the friend record
   * (with the pair fingerprint) and transmits the decision; declining just
   * transmits it. Both outcomes consume the pending request.
   * @param peerId - the requesting peer.
   * @param accept - the local user's decision.
   * @throws `ChatError` with `transport-unavailable` when no transport is registered, or
   * `pairing-unknown` when no incoming request from that peer is pending.
   */
  async respondPairing(peerId: PeerId, accept: boolean): Promise<void> {
    const transport = this.requireTransport()
    const request = this.pending.get(peerId)
    if (request === undefined || request.direction !== 'incoming') {
      throw new ChatError('pairing-unknown', `no incoming pairing request from peer ${peerId} is pending`)
    }
    this.pending.delete(peerId)
    if (accept && this.requireFriends().get(peerId) === undefined) {
      await this.putFriend(peerId, request.displayName)
    }
    this.emitPairing(request, accept ? 'accepted' : 'declined')
    // The accept decision is already durable here, so a transmit failure
    // (peer vanished mid-handshake) leaves the friend added; the peer can
    // re-request later and the auto-accept path completes the pair.
    await transport.transmitPairingResponse(peerId, accept)
  }

  /**
   * End one friendship locally. The record is removed on this side only; the
   * peer keeps its record until it removes it too (v1 has no removal
   * notification), and further messages from it are refused as unpaired.
   * @param peerId - the friend to remove.
   * @returns whether a stored record was removed.
   */
  async removeFriend(peerId: PeerId): Promise<boolean> {
    const removed = await this.requireFriends().delete(peerId)
    if (removed) {
      this.ctx.emit('chat/friend-changed', { peerId, operation: 'removed' })
    }
    return removed
  }

  /**
   * Rename a friend in this home's local address book. The peer's own
   * announced name is unaffected.
   * @param peerId - the friend to rename.
   * @param name - the new local name.
   * @returns the updated record.
   * @throws `ChatError` with `not-paired` when the peer is not a friend, or
   * `invalid-name` when the name is blank or over 64 characters.
   */
  async renameFriend(peerId: PeerId, name: string): Promise<FriendRecord> {
    const friends = this.requireFriends()
    const record = friends.get(peerId)
    if (record === undefined) {
      throw new ChatError('not-paired', `peer ${peerId} is not a friend`)
    }
    const displayName = this.resolveDisplayName(name)
    const updated: FriendRecord = { ...record, displayName }
    await friends.put(peerId, updated)
    this.ctx.emit('chat/friend-changed', { peerId, operation: 'renamed' })
    return updated
  }

  /**
   * Send one message to a friend and wait for the peer's delivery ack. The
   * record persists only on success — there is no offline store-and-forward.
   * @param peerId - the destination friend.
   * @param text - the message text.
   * @returns the stored outbound record.
   * @throws `ChatError` with `transport-unavailable` when no transport is registered,
   * `not-paired` when the peer is not a friend,
   * `invalid-message` when the text is blank,
   * `message-too-long` when the text exceeds the configured limit, or
   * the transport's reachability codes (`peer-unknown`, `peer-offline`).
   */
  async send(peerId: PeerId, text: string): Promise<ChatMessageRecord> {
    const transport = this.requireTransport()
    if (this.requireFriends().get(peerId) === undefined) {
      throw new ChatError('not-paired', `peer ${peerId} is not a friend`)
    }
    if (text.trim().length === 0) {
      throw new ChatError('invalid-message', 'message text must contain non-whitespace characters')
    }
    if (text.length > this.maxMessageChars) {
      throw new ChatError('message-too-long', `message text exceeds the configured limit of ${this.maxMessageChars} characters`)
    }
    const message: InboundChatMessage = {
      messageId: brandString<ChatMessageId>(randomUUID()),
      text,
      sentAt: Date.now(),
    }
    // A throw here (offline peer) persists nothing — the caller retries.
    await transport.deliver(peerId, message)
    const record: ChatMessageRecord = {
      messageId: message.messageId,
      peerId,
      direction: 'out',
      text,
      sentAt: message.sentAt,
      deliveredAt: Date.now(),
    }
    await this.requireMessages().put(record.messageId, record)
    this.ctx.emit('chat/message', { message: record })
    return record
  }

  /**
   * Read one friend's delivered messages, oldest first, ordered by
   * (sentAt, messageId). Failed sends appear nowhere: only delivered
   * messages are durable.
   * @param peerId - the friend whose thread to read.
   * @param limit - most recent messages to return; the default read window is {@link DEFAULT_MESSAGE_LIMIT}.
   * @returns the thread slice in chronological order.
   */
  messages(peerId: PeerId, limit: number = DEFAULT_MESSAGE_LIMIT): ChatMessageRecord[] {
    const thread = [...this.requireMessages().entries()]
      .filter(([, record]) => record.peerId === peerId)
      .sort((left, right) => left[1].sentAt - right[1].sentAt || left[0].localeCompare(right[0]))
      .map(([, record]) => record)
    return limit >= thread.length ? thread : thread.slice(thread.length - limit)
  }

  /** The transport host callbacks a registered transport drives. */
  get host(): ChatTransportHost {
    return this.hostValue ??= {
      onPeerDiscovered: (peer) => { this.onPeerDiscovered(peer) },
      onPeerExpired: (peerId) => { this.onPeerExpired(peerId) },
      onPairingRequest: (peer) => { this.onPairingRequest(peer) },
      onPairingResponse: (peerId, accept) => { this.onPairingResponse(peerId, accept) },
      onMessage: (peerId, message) => this.onMessage(peerId, message),
    }
  }

  /** Mint or load identity, applying the deployment display-name override. */
  private async bootstrapIdentity(): Promise<void> {
    const meta = this.requireMeta()
    const stored = meta.get(IDENTITY_KEY)
    if (stored === undefined) {
      const peerId = brandString<PeerId>(randomUUID())
      const identity: ChatIdentity = {
        peerId,
        displayName: this.displayNameOverride ?? `${hostname()}-${peerId.slice(0, 4)}`,
      }
      await meta.put(IDENTITY_KEY, identity)
      this.identityValue = identity
      return
    }
    if (this.displayNameOverride === undefined || this.displayNameOverride === stored.displayName) {
      this.identityValue = stored
      return
    }
    const identity: ChatIdentity = { ...stored, displayName: this.displayNameOverride }
    await meta.put(IDENTITY_KEY, identity)
    this.identityValue = identity
  }

  /** Store the friend record for a completed pairing and announce it. */
  private async putFriend(peerId: PeerId, displayName: string): Promise<FriendRecord> {
    const record: FriendRecord = {
      peerId,
      displayName,
      pairedAt: Date.now(),
      fingerprint: pairingFingerprint(this.requireIdentity().peerId, peerId),
    }
    await this.requireFriends().put(peerId, record)
    this.ctx.emit('chat/friend-changed', { peerId, operation: 'added' })
    return record
  }

  /** Upsert one announcement and emit `chat/presence` on first sight or rename. */
  private onPeerDiscovered(peer: PeerAnnouncement): void {
    const existing = this.discovered.get(peer.peerId)
    this.discovered.set(peer.peerId, {
      displayName: peer.displayName,
      transport: this.transport?.name ?? 'unknown',
      lastSeen: Date.now(),
    })
    if (existing === undefined || existing.displayName !== peer.displayName) {
      this.ctx.emit('chat/presence', { peerId: peer.peerId, online: true })
    }
  }

  /** Drop one expired announcement and emit `chat/presence`. */
  private onPeerExpired(peerId: PeerId): void {
    if (this.discovered.delete(peerId)) {
      this.ctx.emit('chat/presence', { peerId, online: false })
    }
  }

  /**
   * Handle an incoming pairing request: an existing friend (or an outgoing
   * request from the same peer — both sides asked at once) auto-accepts;
   * anything else pends for a human decision.
   */
  private onPairingRequest(peer: PeerAnnouncement): void {
    const transport = this.transport
    if (transport === undefined) return
    this.onPeerDiscovered(peer)
    const outgoing = this.pending.get(peer.peerId)
    if (this.requireFriends().get(peer.peerId) !== undefined || outgoing?.direction === 'outgoing') {
      if (outgoing !== undefined) this.pending.delete(peer.peerId)
      void this.acceptIncoming(transport, peer)
      return
    }
    const record: PairingRequestRecord = {
      peerId: peer.peerId,
      displayName: peer.displayName,
      direction: 'incoming',
      requestedAt: Date.now(),
    }
    this.pending.set(peer.peerId, record)
    this.emitPairing(record, 'requested')
  }

  /** Complete an auto-accepted pairing; the request side observes `accepted` on its own side. */
  private async acceptIncoming(transport: ChatTransport, peer: PeerAnnouncement): Promise<void> {
    if (this.requireFriends().get(peer.peerId) === undefined) {
      await this.putFriend(peer.peerId, peer.displayName)
    }
    try {
      await transport.transmitPairingResponse(peer.peerId, true)
    } catch (error) {
      this.ctx.logger.warn('dsh-chat: auto-accept response to peer %s failed: %o', peer.peerId, error)
    }
  }

  /** Handle the peer's answer to our outgoing request; unknown answers warn and drop. */
  private onPairingResponse(peerId: PeerId, accept: boolean): void {
    const request = this.pending.get(peerId)
    if (request === undefined || request.direction !== 'outgoing') {
      this.ctx.logger.warn('dsh-chat: ignoring pairing response from peer %s with no pending outgoing request', peerId)
      return
    }
    this.pending.delete(peerId)
    if (!accept) {
      this.emitPairing(request, 'declined')
      return
    }
    void this.putFriend(peerId, request.displayName)
      .then(() => { this.emitPairing(request, 'accepted') })
      .catch((error: unknown) => {
        this.ctx.logger.warn('dsh-chat: storing accepted pairing with peer %s failed: %o', peerId, error)
      })
  }

  /** Accept, durably record, announce, and inject one inbound message; the resolution is the ack. */
  private async onMessage(peerId: PeerId, message: InboundChatMessage): Promise<boolean> {
    const friend = this.requireFriends().get(peerId)
    if (friend === undefined) return false
    if (message.text.trim().length === 0 || message.text.length > this.maxMessageChars) return false
    if (!Number.isSafeInteger(message.sentAt) || message.sentAt < 0) return false
    if (this.requireMessages().get(message.messageId) !== undefined) return true
    const record: ChatMessageRecord = {
      messageId: message.messageId,
      peerId,
      direction: 'in',
      text: message.text,
      sentAt: message.sentAt,
      deliveredAt: Date.now(),
    }
    try {
      await this.requireMessages().put(record.messageId, record)
    } catch (error) {
      // Durability failed: refuse the ack so the sender's retry can land it.
      this.ctx.logger.warn('dsh-chat: persisting inbound message %s failed: %o', message.messageId, error)
      return false
    }
    this.ctx.emit('chat/message', { message: record })
    this.injectIntoLatestAgent(record, friend.displayName)
    return true
  }

  /** Surface one inbound message to the most recently active root agent. */
  private injectIntoLatestAgent(record: ChatMessageRecord, displayName: string): void {
    if (this.injectInto === 'none') return
    const agent = this.latestActiveRoot()
    if (agent === undefined) {
      this.ctx.logger.warn('dsh-chat: no live root agent to inject friend message %s into', record.messageId)
      return
    }
    agent.inject(createUserMessage({
      content: [{ type: 'text', text: `Friend ${displayName} says: ${record.text}` }],
      source: { kind: 'chat', form: 'relay' },
    }))
  }

  /** The root agent with the latest projected event time (header creation as the floor). */
  private latestActiveRoot(): Agent | undefined {
    let latest: Agent | undefined
    let latestAt = -1
    for (const agent of this.ctx.agents.roots()) {
      const activeAt = this.ctx.sessionProjections.stateOf(agent.session, 'chatActivity')?.lastAt
        ?? agent.session.header.createdAt
      if (activeAt > latestAt) {
        latest = agent
        latestAt = activeAt
      }
    }
    return latest
  }

  /** Whether the registered transport currently believes the peer is reachable. */
  private isOnline(peerId: PeerId): boolean {
    return this.transport?.isReachable(peerId) ?? false
  }

  private emitPairing(request: PairingRequestRecord, operation: PairingOperation): void {
    this.ctx.emit('chat/pairing', {
      peerId: request.peerId,
      displayName: request.displayName,
      direction: request.direction,
      operation,
    })
  }

  private requireIdentity(): ChatIdentity {
    if (this.identityValue === undefined) {
      throw new Error('dsh-chat: identity is not initialized yet')
    }
    return this.identityValue
  }

  private requireTransport(): ChatTransport {
    if (this.transport === undefined) {
      throw new ChatError('transport-unavailable', 'dsh-chat: no chat transport is registered')
    }
    return this.transport
  }

  private requireMeta(): KvTable<string, ChatIdentity> {
    if (this.metaTable === undefined) throw new Error('dsh-chat: durable domain is not initialized')
    return this.metaTable
  }

  private requireFriends(): KvTable<FriendRecord['peerId'], FriendRecord> {
    if (this.friendsTable === undefined) throw new Error('dsh-chat: durable domain is not initialized')
    return this.friendsTable
  }

  private requireMessages(): KvTable<ChatMessageRecord['messageId'], ChatMessageRecord> {
    if (this.messagesTable === undefined) throw new Error('dsh-chat: durable domain is not initialized')
    return this.messagesTable
  }

  /** Validate a display name at every write boundary. */
  private resolveDisplayName(name: string): string {
    const displayName = name.trim()
    if (displayName.length === 0 || displayName.length > DISPLAY_NAME_MAX_CHARS) {
      throw new ChatError('invalid-name', `display name must be 1-${DISPLAY_NAME_MAX_CHARS} characters`)
    }
    return displayName
  }
}

export default ChatRuntime
