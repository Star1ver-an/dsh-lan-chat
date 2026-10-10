/**
 * The chat catalog as this Client last read it, owned by the plugin's apply
 * closure: identity, roster, pending pairings, discovered peers, message
 * threads, and per-thread unread counts.
 *
 * Business data lives here, not in a store (packages/client/AGENTS.md):
 * the follow stream yields one complete baseline followed by invalidation
 * frames, each of which triggers a full re-read of the lists — frames carry
 * no row payloads beyond messages, so patch-in-place would drift. Reads are
 * single-flight per list family; a reconnect bumps the generation so stale
 * in-flight answers publish nothing.
 *
 * Unread is derived from the live message flow: an inbound message increments
 * the thread's unread count unless the panel has that thread selected;
 * selecting a thread calls `markRead`, which zeroes the count.
 */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ChatDiscoveredPeerView,
  ChatFrame,
  ChatFriendView,
  ChatIdentityView,
  ChatMessageView,
  ChatPendingPairingView,
} from '@deepseek-ai/dsh-api-chat-controller/types'

/** One chat thread: the message rows plus its unread counter. */
export interface FriendsThread {
  readonly messages: readonly ChatMessageView[]
  readonly unread: number
}

/** The catalog snapshot every friends surface reads. */
export interface FriendsCatalogSnapshot {
  /** This home's identity, undefined until the first baseline arrives. */
  readonly identity?: ChatIdentityView | undefined
  readonly friends: readonly ChatFriendView[]
  readonly pending: readonly ChatPendingPairingView[]
  readonly discovered: readonly ChatDiscoveredPeerView[]
  /** Message threads keyed by peer id; absent for threads never loaded. */
  readonly threads: Readonly<Record<string, FriendsThread>>
  /** False until the first baseline lands. */
  readonly ready: boolean
  /** Last read failure, so the panel can say why it is empty. */
  readonly error?: string | undefined
}

/**
 * Total unread across every thread, for the trigger badge.
 * @param snapshot - the catalog snapshot to sum.
 * @returns the summed unread count of every loaded thread.
 */
export function unreadTotal(snapshot: FriendsCatalogSnapshot): number {
  let total = 0
  for (const thread of Object.values(snapshot.threads)) total += thread.unread
  return total
}

/** One baseline's roster fact set, shared by applyBaseline and refresh. */
interface RosterFacts {
  readonly identity: ChatIdentityView
  readonly friends: readonly ChatFriendView[]
  readonly pending: readonly ChatPendingPairingView[]
  readonly discovered: readonly ChatDiscoveredPeerView[]
}

/** The Remote port the catalog reads through (tests inject a fake). */
export interface FriendsCatalogPort {
  baseline(signal: AbortSignal): AsyncIterable<ChatFrame>
  listFriends(): Promise<readonly ChatFriendView[]>
  listPendingPairings(): Promise<readonly ChatPendingPairingView[]>
  listDiscoveredPeers(): Promise<readonly ChatDiscoveredPeerView[]>
  listMessages(peerId: string, limit: number): Promise<readonly ChatMessageView[]>
  send(peerId: string, text: string): Promise<ChatMessageView>
  requestPairing(peerId: string): Promise<void>
  respondPairing(peerId: string, accept: boolean): Promise<void>
  removeFriend(peerId: string): Promise<boolean>
  renameFriend(peerId: string, name: string): Promise<ChatFriendView>
  setDisplayName(name: string): Promise<ChatIdentityView>
}

/** Catalog source: the snapshot plus its verbs. */
export interface FriendsCatalog extends HostObservable<FriendsCatalogSnapshot> {
  /** Start the follow pump; returns the stop handle. Idempotent. */
  follow(): () => void
  /** Re-read the roster lists (single-flight). */
  refresh(): void
  /** Load one friend's recent thread (single-flight per peer). */
  loadThread(peerId: string, limit?: number): void
  /**
   * Focus the reading thread and zero its unread count; `undefined` clears
   * the focus (panel closed) so later inbound rows count as unread again.
   */
  markRead(peerId: string | undefined): void
  /** Send one message; rejects with the wire failure. */
  send(peerId: string, text: string): Promise<void>
  requestPairing(peerId: string): Promise<void>
  respondPairing(peerId: string, accept: boolean): Promise<void>
  removeFriend(peerId: string): Promise<boolean>
  renameFriend(peerId: string, name: string): Promise<void>
  setDisplayName(name: string): Promise<void>
  /** Drop everything; the next follow starts from nothing. */
  reset(): void
}

const THREAD_LIMIT = 100

/**
 * Create the catalog source.
 * @param port - the Remote seam every read and verb goes through.
 * @param onError - reporter for pump failures (console in production).
 * @returns the catalog observable and its verbs.
 */
export function createFriendsCatalog(
  port: FriendsCatalogPort,
  onError: (error: unknown) => void,
): FriendsCatalog {
  const listeners = new Set<() => void>()
  const empty: FriendsCatalogSnapshot = {
    identity: undefined,
    friends: [],
    pending: [],
    discovered: [],
    threads: {},
    ready: false,
  }
  let snapshot: FriendsCatalogSnapshot = empty
  /** The currently selected thread; inbound messages to it stay read. */
  let readingPeerId: string | undefined
  /** Bumped by reset/stop; stale generations publish nothing. */
  let generation = 0
  let rosterInFlight: Promise<void> | undefined
  const threadInFlight = new Map<string, Promise<void>>()
  let stop: (() => void) | undefined

  const publish = (next: FriendsCatalogSnapshot): void => {
    snapshot = next
    for (const listener of [...listeners]) listener()
  }

  const publishRoster = (facts: RosterFacts): void => {
    publish({ ...snapshot, ...facts, ready: true, error: undefined })
  }

  const failRead = (error: unknown): void => {
    onError(error)
    publish({
      ...snapshot,
      error: error instanceof Error ? error.message : 'reading the chat catalog failed',
    })
  }

  const threadOf = (peerId: string): FriendsThread =>
    snapshot.threads[peerId] ?? { messages: [], unread: 0 }

  const publishThread = (peerId: string, thread: FriendsThread): void => {
    publish({ ...snapshot, threads: { ...snapshot.threads, [peerId]: thread } })
  }

  /**
   * Append one stored message to its thread, dropping a row the thread already
   * renders. A sender's own delivery reaches this catalog twice — once as the
   * value `send()` resolves with and once as the live `message` frame for the
   * same record — in either order, so the sender-minted `messageId` decides
   * identity on both paths.
   * @param message - the stored row to render.
   * @param countUnread - whether an inbound row increments the thread's unread count.
   */
  const appendMessage = (message: ChatMessageView, countUnread: boolean): void => {
    const thread = threadOf(message.peerId)
    if (thread.messages.some(existing => existing.messageId === message.messageId)) return
    publishThread(message.peerId, {
      messages: [...thread.messages, message],
      unread: countUnread ? thread.unread + 1 : thread.unread,
    })
  }

  /** Render one live frame's message, counting an inbound row the user is not reading. */
  const receiveMessage = (message: ChatMessageView): void => {
    const isInbound = message.direction === 'in'
    appendMessage(message, isInbound && readingPeerId !== message.peerId)
  }

  /** Consume one follow stream until it ends or its generation is stale. */
  const pump = async (frames: AsyncIterable<ChatFrame>, issued: number): Promise<void> => {
    for await (const frame of frames) {
      if (issued !== generation) return
      if (frame.type === 'baseline') {
        publishRoster({
          identity: frame.identity,
          friends: frame.friends,
          pending: frame.pending,
          discovered: frame.discovered,
        })
      } else if (frame.type === 'message') {
        receiveMessage(frame.message)
      } else if (frame.type === 'presence') {
        publish({
          ...snapshot,
          friends: snapshot.friends.map(friend =>
            friend.peerId === frame.peerId ? { ...friend, online: frame.online } : friend,
          ),
        })
      } else {
        // pairing / friend-changed carry no row payloads; re-read the roster.
        catalog.refresh()
      }
    }
  }

  const catalog: FriendsCatalog = {
    getSnapshot: () => snapshot,
    subscribe: (fn) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    follow: () => {
      if (stop !== undefined) return stop
      const issued = generation
      const controller = new AbortController()
      const frames = port.baseline(controller.signal)
      // A stop bumps the generation, so its in-flight stream failure is a
      // teardown artifact, not a readable failure.
      const absorbStreamFailure = (error: unknown): void => {
        /* v8 ignore next 2 -- v8 mis-attributes rejections thrown out of
         * async generators; the stale path is asserted in the catalog spec. */
        if (issued !== generation) return
        failRead(error)
      }
      void pump(frames, issued).catch(absorbStreamFailure)
      stop = () => {
        controller.abort()
        if (generation === issued) generation += 1
      }
      return stop
    },
    refresh: () => {
      if (rosterInFlight !== undefined) return
      const issued = generation
      const identity = snapshot.identity
      if (identity === undefined) return
      rosterInFlight = Promise.all([
        port.listFriends(),
        port.listPendingPairings(),
        port.listDiscoveredPeers(),
      ]).then(
        ([friends, pending, discovered]) => {
          if (issued !== generation) return
          publishRoster({ identity, friends, pending, discovered })
        },
        (error: unknown) => {
          if (issued !== generation) return
          failRead(error)
        },
      ).then(() => { if (issued === generation) rosterInFlight = undefined })
    },
    loadThread: (peerId, limit = THREAD_LIMIT) => {
      if (threadInFlight.has(peerId)) return
      const issued = generation
      threadInFlight.set(peerId, port.listMessages(peerId, limit).then(
        (messages) => {
          if (issued !== generation) return
          publishThread(peerId, { messages, unread: threadOf(peerId).unread })
        },
        (error: unknown) => {
          if (issued !== generation) return
          failRead(error)
        },
      ).then(() => { if (issued === generation) threadInFlight.delete(peerId) }))
    },
    markRead: (peerId) => {
      readingPeerId = peerId
      if (peerId === undefined) return
      const thread = threadOf(peerId)
      if (thread.unread === 0) return
      publishThread(peerId, { ...thread, unread: 0 })
    },
    send: async (peerId, text) => {
      appendMessage(await port.send(peerId, text), false)
    },
    requestPairing: async (peerId) => {
      await port.requestPairing(peerId)
      catalog.refresh()
    },
    respondPairing: async (peerId, accept) => {
      await port.respondPairing(peerId, accept)
      catalog.refresh()
    },
    removeFriend: async (peerId) => {
      const removed = await port.removeFriend(peerId)
      catalog.refresh()
      return removed
    },
    renameFriend: async (peerId, name) => {
      await port.renameFriend(peerId, name)
      catalog.refresh()
    },
    setDisplayName: async (name) => {
      const identity = await port.setDisplayName(name)
      publish({ ...snapshot, identity })
    },
    reset: () => {
      generation += 1
      rosterInFlight = undefined
      threadInFlight.clear()
      readingPeerId = undefined
      stop = undefined
      snapshot = empty
      for (const listener of [...listeners]) listener()
    },
  }
  return catalog
}
