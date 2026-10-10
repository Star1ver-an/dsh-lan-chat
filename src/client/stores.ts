/**
 * The friends panel's viewing store: open state, the selected thread, and the
 * composer draft per thread. Module level exports the factory only (a
 * module-level handle would pin the store identity across plugin reloads);
 * one handle is created in `apply` and shared by the sidebar trigger and the
 * overlay panel registrations.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

/** Friends panel viewing state: selection and drafts survive remounts. */
type FriendsViewState = {
  /** Whether the overlay panel is open. */
  open: boolean
  /** The peer whose thread the panel is showing, if any. */
  selectedPeerId?: string | undefined
  /** Composer draft text per thread, keyed by peer id. */
  drafts: Record<string, string>
}

/**
 * Annotation twin of the actions literal below (the export needs a declared
 * return type); drift fails assignability at the defineStore call.
 */
type FriendsViewActions = {
  setOpen: (draft: FriendsViewState, open: boolean) => void
  selectPeer: (draft: FriendsViewState, peerId: string | undefined) => void
  setDraft: (draft: FriendsViewState, peerId: string, text: string) => void
}

/**
 * Create the friends panel viewing store handle.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createFriendsStore(): EngineStoreHandle<FriendsViewState, FriendsViewActions> {
  return defineStore({
    init: (): FriendsViewState => ({
      open: false,
      selectedPeerId: undefined,
      drafts: {},
    }),
    // Deliberately unpersisted: drafts and selection are session-scoped
    // viewing state; the shared instance carries them across open/close.
    actions: {
      setOpen: (d, open: boolean) => { d.open = open },
      selectPeer: (d, peerId: string | undefined) => { d.selectedPeerId = peerId },
      setDraft: (d, peerId: string, text: string) => { d.drafts[peerId] = text },
    },
  })
}
