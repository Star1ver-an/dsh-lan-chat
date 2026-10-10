/**
 * Sidebar footer action: the friends trigger row. Renders the friends icon
 * and, in wide mode, the label plus unread badge. Clicking toggles the panel
 * via the shared store handle.
 */
import {
  IconUserOutlineRegular, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { FriendsCatalog } from './friends.ts'
import type { createFriendsStore } from './stores.ts'
import css from './FriendsAction.module.css'

/** Injected share: the catalog hook and the panel toggle. */
export type FriendsActionInjected = {
  hooks: {
    /** The chat catalog: badge counts unread across all threads. */
    catalog: FriendsCatalog
  }
}

/** Full props: sidebar owner state, catalog hook, store share, locale. */
export type FriendsActionProps =
  PropsRuntime<'sidebar.footer.action'>
  & InjectFace<FriendsActionInjected>
  & PropsStore<ReturnType<typeof createFriendsStore>>
  & PropsLocale<'friends'>

/** Render the friends footer action (trigger + unread badge). */
export function FriendsAction({ wide, useCatalog, useStore, actions, t }: FriendsActionProps) {
  const catalog = useCatalog(snapshot => snapshot)
  const open = useStore(state => state.open)
  const unread = Object.values(catalog.threads).reduce((total, thread) => total + thread.unread, 0)

  const button = (
    <button
      type="button"
      className={css.trigger}
      data-active={open || undefined}
      aria-label={t('trigger.aria')}
      aria-expanded={open}
      onClick={() => { actions.setOpen(!open) }}
    >
      <span className={css.iconWrap}>
        <IconUserOutlineRegular size={wide ? 16 : 18} />
        {unread > 0 && <span className={css.badgeDot} aria-hidden="true" />}
      </span>
      {wide && (
        <>
          <span className={css.label}>{t('trigger.label')}</span>
          {unread > 0 && <span className={css.badgeCount}>{unread}</span>}
        </>
      )}
    </button>
  )

  return wide ? button : (
    <Tooltip label={t('trigger.aria')} side="right" delayMs={400}>
      {button}
    </Tooltip>
  )
}
