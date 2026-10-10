/**
 * Host chat Remote owner: the `ctx.chat` capability surfaced as the generated
 * `ctx.remote.chat` namespace. Reads map the runtime views onto the
 * browser-safe wire vocabulary; every `ChatError` a business call throws is
 * re-thrown as the matching `chat/<code>` `RemoteError`, and one streamed
 * `follow` endpoint carries the baseline plus live invalidation frames.
 * @module @deepseek-ai/dsh-api-chat-controller
 */

import type { Context } from '@deepseek-ai/cordis'
import { ChatError } from '@deepseek-ai/dsh-chat'
import type {
  ChatErrorCode, ChatMessageRecord, DiscoveredPeer, FriendView, PairingRequestRecord, PeerId,
} from '@deepseek-ai/dsh-chat'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteErrorDetailsMap } from '@deepseek-ai/dsh-typert-protocol'
import type {
  ChatDiscoveredPeerView, ChatFriendView, ChatFrame, ChatIdentityView, ChatMessageView,
  ChatPendingPairingView,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host chat business API and Remote namespace owner. */
    chatController: ChatController
  }
}

/** Codes whose details carry the peer the failed call addressed. */
const PEER_CODES: ReadonlySet<ChatErrorCode> = new Set([
  'peer-unknown',
  'peer-offline',
  'not-paired',
  'already-paired',
  'pairing-pending',
  'pairing-unknown',
])

/** Wire details for one mapped chat failure. */
function detailsOf(code: ChatErrorCode, peerId: string | undefined): RemoteErrorDetailsMap[`chat/${ChatErrorCode}`] {
  if (PEER_CODES.has(code)) {
    // v8 ignore next -- every peer-code call site carries the peer it addressed
    if (peerId !== undefined) return { peerId }
  }
  return {}
}

function identityView(identity: { readonly peerId: string; readonly displayName: string }): ChatIdentityView {
  return { peerId: identity.peerId, displayName: identity.displayName }
}

function friendView(view: FriendView): ChatFriendView {
  return {
    peerId: view.record.peerId,
    displayName: view.record.displayName,
    pairedAt: view.record.pairedAt,
    fingerprint: view.record.fingerprint,
    online: view.online,
  }
}

function pendingView(record: PairingRequestRecord): ChatPendingPairingView {
  return {
    peerId: record.peerId,
    displayName: record.displayName,
    direction: record.direction,
    requestedAt: record.requestedAt,
  }
}

function discoveredView(peer: DiscoveredPeer): ChatDiscoveredPeerView {
  return {
    peerId: peer.peerId,
    displayName: peer.displayName,
    transport: peer.transport,
    lastSeen: peer.lastSeen,
  }
}

function messageView(record: ChatMessageRecord): ChatMessageView {
  return {
    messageId: record.messageId,
    peerId: record.peerId,
    direction: record.direction,
    text: record.text,
    sentAt: record.sentAt,
    deliveredAt: record.deliveredAt,
  }
}

/** Host service backing the generated `ctx.remote.chat` namespace. */
export class ChatController extends TypertRemoteService {
  static inject = ['chat', 'typert']

  /** One open follow stream's close handle, for teardown. */
  private readonly streams = new Set<() => void>()

  /** @param ctx - Host context carrying the chat capability. */
  constructor(ctx: Context) {
    super(ctx, 'chatController', { namespace: 'chat' })
    ctx.effect(() => () => {
      for (const close of this.streams) close()
      this.streams.clear()
    }, 'chat-controller.follow')
  }

  /**
   * Read this home's chat identity.
   * @param signal - carrier cancellation, always the final parameter.
   * @returns this home's peer id and current display name.
   */
  @Remote('identity')
  identity(signal: AbortSignal): ChatIdentityView {
    signal.throwIfAborted()
    return identityView(this.ctx.chat.identity)
  }

  /**
   * Read every accepted friend with live reachability.
   * @param signal - carrier cancellation.
   * @returns one row per stored friend, with the transport's current belief.
   */
  @Remote('listFriends')
  listFriends(signal: AbortSignal): ChatFriendView[] {
    signal.throwIfAborted()
    return this.ctx.chat.listFriends().map(view => friendView(view))
  }

  /**
   * Read every pending pairing request, incoming and outgoing.
   * @param signal - carrier cancellation.
   * @returns one row per request still awaiting a decision.
   */
  @Remote('listPendingPairings')
  listPendingPairings(signal: AbortSignal): ChatPendingPairingView[] {
    signal.throwIfAborted()
    return this.ctx.chat.listPendingPairings().map(record => pendingView(record))
  }

  /**
   * Read every peer the transport currently sees on the wire.
   * @param signal - carrier cancellation.
   * @returns one row per live announcement, most recent first.
   */
  @Remote('listDiscoveredPeers')
  listDiscoveredPeers(signal: AbortSignal): ChatDiscoveredPeerView[] {
    signal.throwIfAborted()
    return this.ctx.chat.listDiscoveredPeers().map(peer => discoveredView(peer))
  }

  /**
   * Read one friend's delivered messages, oldest first.
   * @param peerId - the friend whose thread to read.
   * @param limit - most recent messages to return.
   * @param signal - carrier cancellation.
   * @returns the requested slice, oldest first.
   */
  @Remote('listMessages')
  listMessages(peerId: PeerId, limit: number, signal: AbortSignal): ChatMessageView[] {
    signal.throwIfAborted()
    return this.ctx.chat.messages(peerId, limit).map(record => messageView(record))
  }

  /**
   * Send one message to a friend and resolve on the peer's delivery ack.
   * @param peerId - the destination friend.
   * @param text - the message text.
   * @param signal - carrier cancellation.
   * @returns the stored outbound message after the peer acknowledged it.
   */
  @Remote('send')
  async send(peerId: PeerId, text: string, signal: AbortSignal): Promise<ChatMessageView> {
    signal.throwIfAborted()
    try {
      return messageView(await this.ctx.chat.send(peerId, text))
    } catch (error: unknown) {
      this.fail(error, peerId)
    }
  }

  /**
   * Ask a discovered peer to pair; the pairing completes only when it accepts.
   * @param peerId - the peer to request.
   * @param signal - carrier cancellation.
   */
  @Remote('requestPairing')
  async requestPairing(peerId: PeerId, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    try {
      await this.ctx.chat.requestPairing(peerId)
    } catch (error: unknown) {
      this.fail(error, peerId)
    }
  }

  /**
   * Answer one incoming pairing request; both outcomes consume the request.
   * @param peerId - the requesting peer.
   * @param accept - the local user's decision.
   * @param signal - carrier cancellation.
   */
  @Remote('respondPairing')
  async respondPairing(peerId: PeerId, accept: boolean, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    try {
      await this.ctx.chat.respondPairing(peerId, accept)
    } catch (error: unknown) {
      this.fail(error, peerId)
    }
  }

  /**
   * End one friendship locally; the peer keeps its own record.
   * @param peerId - the friend to remove.
   * @param signal - carrier cancellation.
   * @returns whether a stored record was removed.
   */
  @Remote('removeFriend')
  removeFriend(peerId: PeerId, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted()
    return this.ctx.chat.removeFriend(peerId)
  }

  /**
   * Rename a friend in this home's local address book.
   * @param peerId - the friend to rename.
   * @param name - the new local name.
   * @param signal - carrier cancellation.
   * @returns the updated friend view.
   */
  @Remote('renameFriend')
  async renameFriend(peerId: PeerId, name: string, signal: AbortSignal): Promise<ChatFriendView> {
    signal.throwIfAborted()
    try {
      const online = this.ctx.chat.listFriends().some(view => view.record.peerId === peerId && view.online)
      return friendView({ record: await this.ctx.chat.renameFriend(peerId, name), online })
    } catch (error: unknown) {
      this.fail(error, peerId)
    }
  }

  /**
   * Replace this home's display name; peers learn it on their next
   * announcement cycle.
   * @param name - the new display name.
   * @param signal - carrier cancellation.
   * @returns the updated identity view.
   */
  @Remote('setDisplayName')
  async setDisplayName(name: string, signal: AbortSignal): Promise<ChatIdentityView> {
    signal.throwIfAborted()
    try {
      await this.ctx.chat.setDisplayName(name)
    } catch (error: unknown) {
      this.fail(error)
    }
    return identityView(this.ctx.chat.identity)
  }

  /**
   * Stream a complete chat baseline followed by live invalidation frames.
   * @param signal - cancellation owned by the Remote stream carrier.
   * @returns one complete baseline followed by live frames.
   */
  @Remote({ mode: 'stream' })
  follow(signal: AbortSignal): AsyncIterable<ChatFrame> {
    return this.followFrames(signal)
  }

  /**
   * Subscribe before snapshotting so an event arriving during the baseline
   * read is buffered instead of lost; a duplicated refresh hint is cheaper
   * than a permanently stale panel.
   */
  private async *followFrames(signal: AbortSignal): AsyncIterable<ChatFrame> {
    signal.throwIfAborted()
    const buffered: ChatFrame[] = []
    let wake: (() => void) | undefined
    // A bare `let` assigned only inside `close` narrows to its initializer and
    // reads as a constant in the loop below; the object form keeps the flag
    // honestly mutable (the session-controller follower pattern).
    const follower = { closed: false }
    const push = (frame: ChatFrame): void => {
      buffered.push(frame)
      wake?.()
      wake = undefined
    }
    const close = (): void => {
      follower.closed = true
      wake?.()
      wake = undefined
    }
    const onAbort = (): void => { close() }
    signal.addEventListener('abort', onAbort, { once: true })
    const off = this.watch(push)
    this.streams.add(close)
    try {
      yield this.baseline()
      while (!follower.closed && !signal.aborted) {
        const frame = buffered.shift()
        if (frame !== undefined) {
          yield frame
          continue
        }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      this.streams.delete(close)
      signal.removeEventListener('abort', onAbort)
      off()
    }
  }

  /** Subscribe one stream's collector to every live chat event. */
  private watch(push: (frame: ChatFrame) => void): () => void {
    const offs = [
      this.ctx.on('chat/message', ({ message }) => { push({ type: 'message', message: messageView(message) }) }),
      this.ctx.on('chat/presence', ({ peerId, online }) => { push({ type: 'presence', peerId, online }) }),
      this.ctx.on('chat/friend-changed', ({ peerId, operation }) => { push({ type: 'friend-changed', peerId, operation }) }),
      this.ctx.on('chat/pairing', ({ peerId, displayName, direction, operation }) => {
        push({ type: 'pairing', peerId, displayName, direction, operation })
      }),
    ]
    return () => { for (const off of offs) off() }
  }

  /** The complete current state frame a stream opens with. */
  private baseline(): ChatFrame {
    return {
      type: 'baseline',
      identity: identityView(this.ctx.chat.identity),
      friends: this.ctx.chat.listFriends().map(view => friendView(view)),
      pending: this.ctx.chat.listPendingPairings().map(record => pendingView(record)),
      discovered: this.ctx.chat.listDiscoveredPeers().map(peer => discoveredView(peer)),
    }
  }

  /**
   * Re-throw one business failure on the wire: a `ChatError` becomes the
   * matching `chat/<code>` `RemoteError`, and anything else keeps crashing.
   * @param error - the failure the chat capability threw.
   * @param peerId - the peer the call addressed, when it addressed one.
   */
  private fail(error: unknown, peerId?: string): never {
    if (!(error instanceof ChatError)) throw error
    throw new RemoteError(`chat/${error.code}`, error.message, detailsOf(error.code, peerId))
  }
}

export default ChatController
