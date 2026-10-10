/** Data vocabulary of the chat capability: stored records, transport wire inputs, and read views. */

import type { ChatMessageId, PeerId } from './brand.ts'

/** This harness home's chat identity, persisted in the domain's `meta` table. */
export interface ChatIdentity {
  /** Stable peer identity shared in announcements and pairing. */
  readonly peerId: PeerId
  /** Human-readable name shown to peers. */
  readonly displayName: string
}

/** One accepted pairing, persisted durably. */
export interface FriendRecord {
  /** The friend's stable peer identity. */
  readonly peerId: PeerId
  /** The friend's display name, as announced when the pairing completed. */
  readonly displayName: string
  /** Epoch ms when the pairing was accepted on this side. */
  readonly pairedAt: number
  /**
   * Short verification fingerprint both sides derive for the same pair:
   * the first 8 hex characters of the SHA-256 digest over the lexically
   * sorted peer ids. v1 has no key exchange, so comparing this value
   * out-of-band is the only check that both sides paired with each other.
   */
  readonly fingerprint: string
}

/** Which side of the conversation one stored message belongs to. */
export type ChatDirection = 'in' | 'out'

/** One delivered message, persisted durably on both sides. Undelivered sends store nothing. */
export interface ChatMessageRecord {
  /** Sender-minted stable identity; ack deduplication keys on it. */
  readonly messageId: ChatMessageId
  /** The remote participant of this message. */
  readonly peerId: PeerId
  /** `out` for messages this home sent, `in` for messages it received. */
  readonly direction: ChatDirection
  /** The message text. */
  readonly text: string
  /** Epoch ms when the sender created the message. */
  readonly sentAt: number
  /** Epoch ms when this home observed the delivery. */
  readonly deliveredAt: number
}

/** Profile one transport observed from a live peer announcement. */
export interface PeerAnnouncement {
  /** The announcing peer's stable identity. */
  readonly peerId: PeerId
  /** The announcing peer's display name. */
  readonly displayName: string
}

/** One pairing handshake message content. */
export interface InboundChatMessage {
  /** Sender-minted stable identity. */
  readonly messageId: ChatMessageId
  /** The message text. */
  readonly text: string
  /** Epoch ms when the sender created the message. */
  readonly sentAt: number
}

/**
 * Direction of one pending pairing: `outgoing` waits for the peer's
 * response, `incoming` waits for the local user's decision.
 */
export type PairingDirection = 'incoming' | 'outgoing'

/** One pairing request awaiting completion. Pending pairings are process-local. */
export interface PairingRequestRecord {
  /** The other side's stable peer identity. */
  readonly peerId: PeerId
  /** The other side's display name, as last announced or received. */
  readonly displayName: string
  /** Which side created the request. */
  readonly direction: PairingDirection
  /** Epoch ms when the request was created on this side. */
  readonly requestedAt: number
}

/** Lifecycle operation carried by `chat/friend-changed`. */
export type FriendChangeOperation = 'added' | 'removed' | 'renamed'

/** Lifecycle operation carried by `chat/pairing`. */
export type PairingOperation = 'requested' | 'accepted' | 'declined' | 'cancelled'

/**
 * Callbacks a registered transport drives into the runtime. All methods are
 * plain synchronous notifications except {@link ChatTransportHost.onMessage},
 * whose resolution decides the delivery ack.
 */
export interface ChatTransportHost {
  /**
   * A peer announced itself on the transport.
   * @param peer - the peer's stable identity and display name.
   */
  onPeerDiscovered(peer: PeerAnnouncement): void
  /**
   * A peer stopped being reachable; its discovered entry is gone.
   * @param peerId - the peer whose entry expired.
   */
  onPeerExpired(peerId: PeerId): void
  /**
   * An unpaired (or paired) peer asked to pair with this home.
   * @param peer - the requester's stable identity and display name.
   */
  onPairingRequest(peer: PeerAnnouncement): void
  /**
   * A peer answered this home's pairing request.
   * @param peerId - the responding peer.
   * @param accept - whether the peer accepted.
   */
  onPairingResponse(peerId: PeerId, accept: boolean): void
  /**
   * A paired peer delivered one message. The resolved value is the delivery
   * decision: `true` accepts and acks, `false` refuses (unpaired, closed, or
   * rejected duplicate).
   * @param peerId - the sending peer.
   * @param message - the sender-minted message content.
   * @returns whether the message was accepted.
   */
  onMessage(peerId: PeerId, message: InboundChatMessage): Promise<boolean>
}

/**
 * One swappable chat transport (the Service Provider role of the seam). A
 * transport owns the wire: peer discovery, connections, framing, and delivery
 * acknowledgements. It reports peer facts through its {@link ChatTransportHost}
 * and forwards exactly the calls the runtime asks of it.
 */
export interface ChatTransport {
  /** Transport identity used in diagnostics and discovered-peer records. */
  readonly name: string
  /**
   * Begin operating: bind sockets, start announcements. Resolves once the
   * transport is serving; a rejection fails the registering plugin loud.
   * @returns resolution once the transport is live.
   */
  start(): Promise<void>
  /**
   * Release the wire: close sockets and stop announcing. Idempotent.
   * @returns resolution once the transport is released.
   */
  stop(): Promise<void>
  /**
   * Deliver one message to a paired peer and resolve on the peer's ack.
   * @param peerId - the destination peer.
   * @param message - the sender-minted message content.
   * @throws `ChatError` with `peer-offline` or `peer-unknown` when the peer is unreachable.
   */
  deliver(peerId: PeerId, message: InboundChatMessage): Promise<void>
  /**
   * Reach a peer with a pairing request.
   * @param peerId - the destination peer.
   * @throws `ChatError` with `peer-unknown` or `peer-offline` when the peer is unreachable.
   */
  transmitPairingRequest(peerId: PeerId): Promise<void>
  /**
   * Answer a peer's pairing request.
   * @param peerId - the requesting peer.
   * @param accept - the local user's decision.
   * @throws `ChatError` with `peer-offline` when the requester is gone.
   */
  transmitPairingResponse(peerId: PeerId, accept: boolean): Promise<void>
  /**
   * Whether the transport currently believes one peer is reachable.
   * @param peerId - the peer to probe.
   * @returns the transport's live reachability belief.
   */
  isReachable(peerId: PeerId): boolean
}

/** One discovered peer as consumers read it. */
export interface DiscoveredPeer {
  /** The peer's stable identity. */
  readonly peerId: PeerId
  /** The peer's display name, as last announced. */
  readonly displayName: string
  /** Name of the transport that observed the announcement. */
  readonly transport: string
  /** Epoch ms of the most recent announcement. */
  readonly lastSeen: number
}

/** One friend as consumers read it: the durable record plus the transport's live reachability. */
export interface FriendView {
  /** The stored pairing record. */
  readonly record: FriendRecord
  /** Whether the transport currently believes the friend is reachable. */
  readonly online: boolean
}
