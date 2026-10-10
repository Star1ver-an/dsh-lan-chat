/**
 * The friends overlay panel: roster, pending pairings, discovered devices,
 * and the selected thread's message view. Renders into `shell.overlay`; the
 * shared store handle carries open/selection/draft state between this entry
 * and the sidebar trigger. Closing is explicit (header button or the trigger
 * toggle) — an outside-pointer dismiss would fight the trigger's own toggle.
 */
import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Button, IconCheckOutlineRegular, IconCloseOutlineRegular, IconEditOutlineRegular, IconPlusOutlineRegular,
  IconSendOutlineRegular, IconTrashOutlineRegular, Input, StateDot, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore, Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {
  ChatDiscoveredPeerView, ChatFriendView, ChatIdentityView, ChatMessageView, ChatPendingPairingView,
} from '@deepseek-ai/dsh-api-chat-controller/types'
import type { FriendsCatalog } from './friends.ts'
import type { createFriendsStore } from './stores.ts'
import type { FriendsKey } from './locales.ts'
import css from './FriendsPanel.module.css'

/** Injected share: the catalog hook and every verb the panel can invoke. */
export type FriendsPanelInjected = {
  hooks: {
    /** The chat catalog. */
    catalog: FriendsCatalog
  }
  /** Zero one thread's unread count (or clear the reading focus). */
  markRead: (peerId: string | undefined) => void
  /** Load one friend's recent thread. */
  loadThread: (peerId: string) => void
  /** Send one message; rejects with the wire failure. */
  send: (peerId: string, text: string) => Promise<void>
  /** Ask a discovered peer to pair. */
  requestPairing: (peerId: string) => Promise<void>
  /** Answer one incoming pairing request. */
  respondPairing: (peerId: string, accept: boolean) => Promise<void>
  /** End one friendship locally. */
  removeFriend: (peerId: string) => Promise<boolean>
  /** Replace this home's display name. */
  setDisplayName: (name: string) => Promise<void>
}

/** Full panel props composed by the shell.overlay slot. */
export type FriendsPanelProps =
  PropsRuntime<'shell.overlay'>
  & InjectFace<FriendsPanelInjected>
  & PropsStore<ReturnType<typeof createFriendsStore>>
  & PropsLocale<'friends'>

// ---- Roster rows -----------------------------------------------------------

/** One friend row: presence dot, name, unread badge, and the remove action. */
function FriendRow({ friend, unread, onSelect, onRemove, t }: {
  friend: ChatFriendView
  unread: number
  onSelect: () => void
  onRemove: () => void
  t: Translate<FriendsKey>
}) {
  const [confirming, setConfirming] = useState(false)
  return (
    <li className={css.row}>
      <button type="button" className={css.rowBody} onClick={onSelect}>
        <StateDot state={friend.online ? 'done' : 'error'} size={8} />
        <span className={css.rowName}>{friend.displayName}</span>
        <span className={css.rowStatus}>{t(friend.online ? 'friend.online' : 'friend.offline')}</span>
        {unread > 0 && (
          <span className={css.unreadBadge} aria-label={t('friend.unread', { count: unread })}>
            {unread}
          </span>
        )}
      </button>
      <span className={css.rowActions}>
        {confirming ? (
          <>
            <span className={css.confirmText}>{t('friend.remove.confirm', { name: friend.displayName })}</span>
            <Button
              size="sm"
              onClick={() => { setConfirming(false); onRemove() }}
            >
              {t('panel.renameSelf.confirm')}
            </Button>
            <Button size="sm" onClick={() => { setConfirming(false) }}>
              {t('pending.decline')}
            </Button>
          </>
        ) : (
          <Tooltip label={t('friend.remove')} side="bottom" delayMs={400}>
            <button
              type="button"
              className={css.actionIcon}
              aria-label={t('friend.remove')}
              onClick={() => { setConfirming(true) }}
            >
              <IconTrashOutlineRegular size={14} />
            </button>
          </Tooltip>
        )}
      </span>
    </li>
  )
}

/** One pending pairing row: accept/decline (incoming) or withdraw (outgoing). */
function PendingRow({ pending, onAccept, onDecline, t }: {
  pending: ChatPendingPairingView
  onAccept: () => void
  onDecline: () => void
  t: Translate<FriendsKey>
}) {
  return (
    <li className={css.row}>
      <span className={css.rowBody}>
        <StateDot state="warning" size={8} />
        <span className={css.rowName}>{pending.displayName}</span>
        <span className={css.rowStatus}>
          {t(pending.direction === 'incoming' ? 'pending.incoming' : 'pending.outgoing', {
            name: pending.displayName,
          })}
        </span>
      </span>
      <span className={css.rowActions}>
        {pending.direction === 'incoming' ? (
          <>
            <Tooltip label={t('pending.accept')} side="bottom" delayMs={400}>
              <button
                type="button"
                className={`${css.actionIcon} ${css.actionAccept}`}
                aria-label={t('pending.accept')}
                onClick={onAccept}
              >
                <IconCheckOutlineRegular size={14} />
              </button>
            </Tooltip>
            <Tooltip label={t('pending.decline')} side="bottom" delayMs={400}>
              <button
                type="button"
                className={css.actionIcon}
                aria-label={t('pending.decline')}
                onClick={onDecline}
              >
                <IconCloseOutlineRegular size={14} />
              </button>
            </Tooltip>
          </>
        ) : (
          <Tooltip label={t('pending.cancel')} side="bottom" delayMs={400}>
            <button
              type="button"
              className={css.actionIcon}
              aria-label={t('pending.cancel')}
              onClick={onDecline}
            >
              <IconCloseOutlineRegular size={14} />
            </button>
          </Tooltip>
        )}
      </span>
    </li>
  )
}

/** One discovered peer row: name, transport, and the add action. */
function DiscoveredRow({ peer, onAdd, t }: {
  peer: ChatDiscoveredPeerView
  onAdd: () => void
  t: Translate<FriendsKey>
}) {
  return (
    <li className={css.row}>
      <span className={css.rowBody}>
        <StateDot state="ongoing" size={8} />
        <span className={css.rowName}>{peer.displayName}</span>
        <span className={css.rowStatus}>{peer.transport}</span>
      </span>
      <span className={css.rowActions}>
        <Tooltip label={t('discovered.add')} side="bottom" delayMs={400}>
          <button
            type="button"
            className={`${css.actionIcon} ${css.actionAccept}`}
            aria-label={t('discovered.add')}
            onClick={onAdd}
          >
            <IconPlusOutlineRegular size={14} />
          </button>
        </Tooltip>
      </span>
    </li>
  )
}

// ---- Thread view pieces ----------------------------------------------------

/** One message bubble. */
function MessageBubble({ message }: { message: ChatMessageView }) {
  const isOut = message.direction === 'out'
  return (
    <li className={`${css.bubble} ${isOut ? css.bubbleOut : css.bubbleIn}`}>
      <span className={css.bubbleText}>{message.text}</span>
    </li>
  )
}

/** The selected friend's thread: header, messages, composer. */
function ThreadView({ peerId, friend, thread, draft, onDraft, onBack, onSend, t }: {
  peerId: string
  friend: ChatFriendView
  thread: { readonly messages: readonly ChatMessageView[] } | undefined
  draft: string
  onDraft: (text: string) => void
  onBack: () => void
  onSend: (text: string) => Promise<void>
  t: Translate<FriendsKey>
}) {
  const [sendError, setSendError] = useState<string | undefined>()
  const listRef = useRef<HTMLUListElement>(null)
  const messageCount = thread?.messages.length ?? 0

  // New rows land at the bottom; keep the latest message in view. Direct
  // scrollTop assignment (jsdom implements no scrollTo).
  useEffect(() => {
    const list = listRef.current
    // The ref is attached whenever this effect can run; the guard only
    // satisfies the nullable-ref type (uncoverable by construction).
    /* v8 ignore next */
    if (list !== null) list.scrollTop = list.scrollHeight
  }, [messageCount])

  const submit = async (): Promise<void> => {
    const text = draft.trim()
    if (text === '') return
    setSendError(undefined)
    try {
      await onSend(text)
      onDraft('')
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <div className={css.thread}>
      <div className={css.threadHeader}>
        <button
          type="button"
          className={css.backButton}
          aria-label={t('thread.back')}
          onClick={onBack}
        >
          ‹
        </button>
        <StateDot state={friend.online ? 'done' : 'error'} size={8} />
        <span className={css.threadName}>{friend.displayName}</span>
        <Tooltip label={t('friend.fingerprint', { fingerprint: friend.fingerprint })} side="bottom" delayMs={400}>
          <span className={css.fingerprint}>{friend.fingerprint}</span>
        </Tooltip>
      </div>
      <ul ref={listRef} className={css.messageList} aria-live="polite" data-friends-thread={peerId}>
        {messageCount === 0
          ? <li className={css.notice}>{t('thread.empty')}</li>
          : thread?.messages.map(message => (
            <MessageBubble key={message.messageId} message={message} />
          ))}
      </ul>
      <div className={css.composer}>
        {sendError !== undefined && (
          <p className={css.sendError} role="alert">{t('composer.sendFailed', { message: sendError })}</p>
        )}
        <div className={css.composerRow}>
          <Input
            className={clsx(css.composerInput)}
            value={draft}
            placeholder={t('composer.placeholder', { name: friend.displayName })}
            onChange={(event) => { onDraft(event.target.value) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void submit()
              }
            }}
          />
          <Tooltip label={t('composer.send')} side="bottom" delayMs={400}>
            <button
              type="button"
              className={`${css.actionIcon} ${css.actionAccept}`}
              aria-label={t('composer.send')}
              disabled={draft.trim() === ''}
              onClick={() => { void submit() }}
            >
              <IconSendOutlineRegular size={16} />
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
  )
}

/** The signed-in identity tag in the header, with the rename affordance. */
function IdentityTag({ identity, onBeginRename, t }: {
  identity: ChatIdentityView
  onBeginRename: (name: string) => void
  t: Translate<FriendsKey>
}) {
  return (
    <span className={css.headerIdentity}>
      {t('panel.identity', { name: identity.displayName })}
      <Tooltip label={t('panel.renameSelf')} side="bottom" delayMs={400}>
        <button
          type="button"
          className={css.actionIcon}
          aria-label={t('panel.renameSelf')}
          onClick={() => { onBeginRename(identity.displayName) }}
        >
          <IconEditOutlineRegular size={14} />
        </button>
      </Tooltip>
    </span>
  )
}

// ---- Main panel ------------------------------------------------------------

/** Render the friends overlay panel. */
export function FriendsPanel({
  useCatalog, useStore, actions,
  markRead, loadThread, send, requestPairing, respondPairing, removeFriend, setDisplayName,
  t,
}: FriendsPanelProps) {
  const catalog = useCatalog(snapshot => snapshot)
  const open = useStore(state => state.open)
  const selectedPeerId = useStore(state => state.selectedPeerId)
  const drafts = useStore(state => state.drafts)
  const [renamingSelf, setRenamingSelf] = useState(false)
  const [selfNameDraft, setSelfNameDraft] = useState('')

  // Loading a thread also reads it: unread zeroes while the panel shows the
  // thread, and clears on close so later rows count as unread again.
  useEffect(() => {
    if (!open) {
      markRead(undefined)
      return
    }
    if (selectedPeerId !== undefined) {
      markRead(selectedPeerId)
      loadThread(selectedPeerId)
    }
  }, [selectedPeerId, open, markRead, loadThread])

  if (!open) return null

  const selectedFriend = selectedPeerId !== undefined
    ? catalog.friends.find(friend => friend.peerId === selectedPeerId)
    : undefined

  const saveDisplayName = (): void => {
    void setDisplayName(selfNameDraft.trim()).then(() => { setRenamingSelf(false) })
  }

  const renderRoster = (): ReactNode => (
    <div className={css.roster} data-friends-roster="">
      {catalog.error !== undefined && (
        <p className={css.notice} role="alert">{t('panel.readFailed', { message: catalog.error })}</p>
      )}
      {!catalog.ready && catalog.error === undefined && (
        <p className={css.notice}>{t('panel.loading')}</p>
      )}
      {catalog.ready && catalog.friends.length === 0
        && catalog.pending.length === 0 && catalog.discovered.length === 0 && (
        <p className={css.notice}>{t('panel.empty')}</p>
      )}

      {catalog.friends.length > 0 && (
        <section>
          <h3 className={css.sectionHeading}>{t('section.friends')}</h3>
          <ul className={css.rows}>
            {catalog.friends.map(friend => (
              <FriendRow
                key={friend.peerId}
                friend={friend}
                unread={catalog.threads[friend.peerId]?.unread ?? 0}
                onSelect={() => { actions.selectPeer(friend.peerId) }}
                onRemove={() => { void removeFriend(friend.peerId) }}
                t={t}
              />
            ))}
          </ul>
        </section>
      )}

      {catalog.pending.length > 0 && (
        <section>
          <h3 className={css.sectionHeading}>{t('section.pending')}</h3>
          <ul className={css.rows}>
            {catalog.pending.map(pending => (
              <PendingRow
                key={pending.peerId}
                pending={pending}
                onAccept={() => { void respondPairing(pending.peerId, true) }}
                onDecline={() => { void respondPairing(pending.peerId, false) }}
                t={t}
              />
            ))}
          </ul>
        </section>
      )}

      {catalog.discovered.length > 0 && (
        <section>
          <h3 className={css.sectionHeading}>{t('section.discovered')}</h3>
          <ul className={css.rows}>
            {catalog.discovered
              .filter(peer => !catalog.friends.some(friend => friend.peerId === peer.peerId))
              .map(peer => (
                <DiscoveredRow
                  key={peer.peerId}
                  peer={peer}
                  onAdd={() => { void requestPairing(peer.peerId) }}
                  t={t}
                />
              ))}
          </ul>
        </section>
      )}
    </div>
  )

  return (
    <div className={css.panel} data-friends-panel="" role="dialog" aria-label={t('panel.title')}>
      <header className={css.header}>
        <span className={css.headerTitle}>{t('panel.title')}</span>
        {catalog.identity !== undefined && (
          <IdentityTag
            identity={catalog.identity}
            onBeginRename={(name) => {
              setRenamingSelf(true)
              setSelfNameDraft(name)
            }}
            t={t}
          />
        )}
        <button
          type="button"
          className={css.actionIcon}
          aria-label={t('panel.close')}
          onClick={() => { actions.setOpen(false) }}
        >
          <IconCloseOutlineRegular size={14} />
        </button>
      </header>

      {renamingSelf && (
        <div className={css.renameRow} data-friends-rename-self="">
          <Input
            value={selfNameDraft}
            placeholder={t('panel.renameSelf.hint')}
            onChange={(event) => { setSelfNameDraft(event.target.value) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') saveDisplayName()
              if (event.key === 'Escape') setRenamingSelf(false)
            }}
          />
          <Button size="sm" onClick={saveDisplayName}>
            {t('panel.renameSelf.confirm')}
          </Button>
          <Button size="sm" onClick={() => { setRenamingSelf(false) }}>
            {t('panel.renameSelf.cancel')}
          </Button>
        </div>
      )}

      {selectedFriend !== undefined && selectedPeerId !== undefined
        ? (
          <ThreadView
            peerId={selectedPeerId}
            friend={selectedFriend}
            thread={catalog.threads[selectedPeerId]}
            draft={drafts[selectedPeerId] ?? ''}
            onDraft={(text) => { actions.setDraft(selectedPeerId, text) }}
            onBack={() => { actions.selectPeer(undefined) }}
            onSend={text => send(selectedPeerId, text)}
            t={t}
          />
        )
        : renderRoster()}
    </div>
  )
}
