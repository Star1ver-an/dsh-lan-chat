/**
 * Browser-safe request, result, and failure vocabulary of the chat Remote
 * service. Host-only symbols stay out: a Client compilation face reads this
 * module directly, so the ids below are plain strings naming the chat
 * capability's branded identities.
 * @module @deepseek-ai/dsh-api-chat-controller/types
 */

import type {} from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The chat capability is composed but no transport claims the wire slot. */
    'chat/transport-unavailable': {}
    /** No live peer carries that id on the registered transport. */
    'chat/peer-unknown': { readonly peerId: string }
    /** The peer is known but has no usable connection right now. */
    'chat/peer-offline': { readonly peerId: string }
    /** The addressed peer is not a friend. */
    'chat/not-paired': { readonly peerId: string }
    /** The peer is already a friend. */
    'chat/already-paired': { readonly peerId: string }
    /** A pairing request with the peer is already pending. */
    'chat/pairing-pending': { readonly peerId: string }
    /** No incoming pairing request from the peer is awaiting a decision. */
    'chat/pairing-unknown': { readonly peerId: string }
    /** A display name is blank or over the display-name policy. */
    'chat/invalid-name': {}
    /** Message text carries no non-whitespace characters. */
    'chat/invalid-message': {}
    /** Message text exceeds the configured length limit. */
    'chat/message-too-long': {}
    /** The harness home is shutting down. */
    'chat/closed': {}
  }
}

/** This harness home's chat identity as a Client reads it. */
export interface ChatIdentityView {
  /** Stable peer identity shared in announcements and pairing. */
  readonly peerId: string
  /** Human-readable name shown to peers. */
  readonly displayName: string
}

/** One accepted friend: the durable pairing facts plus live reachability. */
export interface ChatFriendView {
  /** The friend's stable peer identity. */
  readonly peerId: string
  /** The friend's display name, as last stored locally. */
  readonly displayName: string
  /** Epoch ms when the pairing was accepted on this side. */
  readonly pairedAt: number
  /** Short verification fingerprint both sides derive for the same pair. */
  readonly fingerprint: string
  /** Whether the transport currently believes the friend is reachable. */
  readonly online: boolean
}

/** Which side of one pending pairing created the request. */
export type ChatPairingDirection = 'incoming' | 'outgoing'

/** One pairing request awaiting completion; process-local by design. */
export interface ChatPendingPairingView {
  /** The other side's stable peer identity. */
  readonly peerId: string
  /** The other side's display name, as last known. */
  readonly displayName: string
  /** Which side created the request. */
  readonly direction: ChatPairingDirection
  /** Epoch ms when the request was created on this side. */
  readonly requestedAt: number
}

/** One peer the transport currently sees on the wire. */
export interface ChatDiscoveredPeerView {
  /** The peer's stable identity. */
  readonly peerId: string
  /** The peer's display name, as last announced. */
  readonly displayName: string
  /** Name of the transport that observed the announcement. */
  readonly transport: string
  /** Epoch ms of the most recent announcement. */
  readonly lastSeen: number
}

/** Which side of the conversation one stored message belongs to. */
export type ChatMessageDirection = 'in' | 'out'

/** One delivered message as a Client reads it; only delivered messages exist. */
export interface ChatMessageView {
  /** Sender-minted stable identity; ack deduplication keys on it. */
  readonly messageId: string
  /** The remote participant of this message. */
  readonly peerId: string
  /** `out` for messages this home sent, `in` for messages it received. */
  readonly direction: ChatMessageDirection
  /** The message text. */
  readonly text: string
  /** Epoch ms when the sender created the message. */
  readonly sentAt: number
  /** Epoch ms when this home observed the delivery. */
  readonly deliveredAt: number
}

/** Lifecycle operation carried by a `friend-changed` frame. */
export type ChatFriendChangeOperation = 'added' | 'removed' | 'renamed'

/** Lifecycle operation carried by a `pairing` frame. */
export type ChatPairingOperation = 'requested' | 'accepted' | 'declined' | 'cancelled'

/**
 * One live chat stream frame: a complete baseline followed by the invalidation
 * signals a panel needs to re-read. Every live frame is a refresh hint, not a
 * full row set; a Client re-reads the lists it renders.
 */
export type ChatFrame =
  | {
    /** Complete current state at stream start. */
    readonly type: 'baseline'
    /** This home's chat identity. */
    readonly identity: ChatIdentityView
    /** All accepted friends with live reachability. */
    readonly friends: ChatFriendView[]
    /** Pending pairing requests, incoming and outgoing. */
    readonly pending: ChatPendingPairingView[]
    /** Peers the transport currently sees on the wire. */
    readonly discovered: ChatDiscoveredPeerView[]
  }
  /** One message became durable in this home's log. */
  | { readonly type: 'message'; readonly message: ChatMessageView }
  /** A discovered peer entered or left the live set. */
  | { readonly type: 'presence'; readonly peerId: string; readonly online: boolean }
  /** The pairing state machine moved. */
  | {
    readonly type: 'pairing'
    readonly peerId: string
    readonly displayName: string
    readonly direction: ChatPairingDirection
    readonly operation: ChatPairingOperation
  }
  /** The friend set or one friend's local record changed. */
  | { readonly type: 'friend-changed'; readonly peerId: string; readonly operation: ChatFriendChangeOperation }
