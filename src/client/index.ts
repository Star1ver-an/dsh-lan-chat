/**
 * Friends plugin, browser half. Two registrations sharing one store handle:
 * FriendsAction fills the sidebar shell's `sidebar.footer.action` hole (the
 * trigger with the unread badge), and FriendsPanel fills the layout's
 * `shell.overlay` list (the roster/pairing/thread panel). All chat data flows
 * through the chat catalog over `ctx.remote.chat`; the follow stream is owned
 * by the apply closure and restarts on every connection generation.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { PeerId } from '@deepseek-ai/dsh-chat/brand'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the chat namespace merge (ctx.remote.chat) and wire views.
import type {} from '@deepseek-ai/dsh-api-chat-controller/types'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { FriendsAction, type FriendsActionInjected } from './FriendsAction.tsx'
import { FriendsPanel, type FriendsPanelInjected } from './FriendsPanel.tsx'
import { createFriendsCatalog, type FriendsCatalog, type FriendsCatalogPort } from './friends.ts'
import { createFriendsStore } from './stores.ts'
import { en, NS, zh, type FriendsKey } from './locales.ts'

export type { FriendsActionInjected, FriendsActionProps } from './FriendsAction.tsx'
export type { FriendsPanelInjected, FriendsPanelProps } from './FriendsPanel.tsx'
export type {
  FriendsCatalog, FriendsCatalogPort, FriendsCatalogSnapshot, FriendsThread,
} from './friends.ts'
export type { FriendsKey } from './locales.ts'
export { NS }

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Friend roster, pairing, and thread copy. */
    friends: FriendsKey
  }
}

/** Services required by the two slot registrations and the chat Remote face. */
export const inject = ['slots', 'locale', 'remote', 'remote.chat']

/** The client sees the wire views' plain id strings; the Remote face brands them. */
const asPeer = (peerId: string): PeerId => peerId as PeerId

/** Unwrap one RemoteResult: failures carry their wire message. */
async function unwrap<T>(call: Promise<RemoteResult<T>>): Promise<T> {
  const result = await call
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/** Build the catalog's port over the generated chat Remote namespace. */
function chatPort(ctx: ClientContext): FriendsCatalogPort {
  const chat = ctx.remote.chat
  return {
    baseline: signal => chat.follow(signal),
    listFriends: () => unwrap(chat.listFriends()),
    listPendingPairings: () => unwrap(chat.listPendingPairings()),
    listDiscoveredPeers: () => unwrap(chat.listDiscoveredPeers()),
    listMessages: (peerId, limit) => unwrap(chat.listMessages(asPeer(peerId), limit)),
    send: (peerId, text) => unwrap(chat.send(asPeer(peerId), text)),
    requestPairing: peerId => unwrap(chat.requestPairing(asPeer(peerId))),
    respondPairing: (peerId, accept) => unwrap(chat.respondPairing(asPeer(peerId), accept)),
    removeFriend: peerId => unwrap(chat.removeFriend(asPeer(peerId))),
    renameFriend: (peerId, name) => unwrap(chat.renameFriend(asPeer(peerId), name)),
    setDisplayName: name => unwrap(chat.setDisplayName(name)),
  }
}

/**
 * One baseline-follow stream per connection generation: reset the catalog,
 * follow until the stream ends, then wait for the next `connection/reset`
 * before restarting. Waiting instead of retrying keeps a downed Host from
 * spinning the page; the reset event also fires on the first connect, which
 * recovers an apply that ran before the wire was up.
 */
function followChat(ctx: ClientContext, catalog: FriendsCatalog): () => void {
  // Flags live in an object so the async loop and the teardown closure read
  // the same mutable cell (a bare `let` would narrow to its initializer).
  const state = { stopped: false }
  let stopStream: (() => void) | undefined
  let wake: (() => void) | undefined
  let detachReset: (() => void) | undefined
  const pump = async (): Promise<void> => {
    while (!state.stopped) {
      // Abandon the previous generation's stream before re-following.
      stopStream?.()
      stopStream = undefined
      catalog.reset()
      // A port that throws synchronously must not kill the loop; the next
      // connection generation retries.
      try {
        stopStream = catalog.follow()
      } catch (error) {
        console.error('[ui-friends] chat follow failed:', error)
      }
      await new Promise<void>((resolve) => {
        wake = resolve
        detachReset = ctx.on('connection/reset', () => { resolve() })
      })
      wake = undefined
      detachReset?.()
      detachReset = undefined
    }
  }
  void pump().catch((error: unknown) => {
    console.error('[ui-friends] chat follow loop crashed:', error)
  })
  return () => {
    state.stopped = true
    stopStream?.()
    detachReset?.()
    wake?.()
  }
}

/**
 * Register the trigger and the panel once their slot declarations are on the
 * ledger. Both entries share one store handle, so the trigger toggles the
 * panel and drafts/selection survive open/close.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-friends: dictionaries')

  const catalog = createFriendsCatalog(chatPort(ctx), (error) => {
    console.error('[ui-friends] reading the chat catalog failed:', error)
  })
  // Factory form: the effect body must START the follow loop and return its
  // disposer; calling followChat eagerly would hand cordis the disposer as
  // the body, tearing the stream down the moment it started.
  ctx.effect(() => followChat(ctx, catalog), 'ui-friends: chat follow stream')
  const store = createFriendsStore()

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'friends-panel',
    locale: NS,
    store,
    inject: (): FriendsActionInjected => ({ hooks: { catalog } }),
  }, FriendsAction))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'friends-panel',
    locale: NS,
    store,
    inject: (): FriendsPanelInjected => ({
      hooks: { catalog },
      markRead: (peerId) => { catalog.markRead(peerId) },
      loadThread: (peerId) => { catalog.loadThread(peerId) },
      send: (peerId, text) => catalog.send(peerId, text),
      requestPairing: peerId => catalog.requestPairing(peerId),
      respondPairing: (peerId, accept) => catalog.respondPairing(peerId, accept),
      removeFriend: peerId => catalog.removeFriend(peerId),
      setDisplayName: name => catalog.setDisplayName(name),
    }),
  }, FriendsPanel))
}
