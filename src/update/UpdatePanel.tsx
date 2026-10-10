import { useSyncExternalStore } from 'react'
import type { UpdateClient } from './client.ts'
import type { UpdateKey } from './locales.ts'
import css from './UpdatePanel.module.css'
export function UpdatePanel({client, t}:{client:UpdateClient;t:(key:UpdateKey)=>string}) {
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot)
  const working = ['checking','installing'].includes(state.phase)
  const errors: Record<string,UpdateKey> = { network:'update.network', service:'update.service', incompatible:'update.incompatible', install:'update.failed' }
  return <details className={css.panel}>
    <summary>{t('update.title')} · {state.latest ? `${t('update.ready')} ${state.latest}` : `v${state.current}`}{state.phase === 'restart-required' ? ' ✓' : ''}</summary>
    <div className={css.content}>
      <p>{t('update.current')} {state.current}</p>
      <p role="status">{t(state.phase === 'restart-required' ? 'update.restart' : state.phase === 'installing' ? 'update.installing' : state.phase === 'checking' ? 'update.checking' : state.latest ? 'update.ready' : state.checkedAt && !state.error ? 'update.none' : 'update.unchecked')}{state.latest && state.phase === 'available' ? ` ${state.latest}` : ''}</p>
      {state.error && <p role="alert">{t(errors[state.error] ?? 'update.failed')}</p>}
      {state.latest && state.blocked && <p>{t(state.blocked === 'sharing' ? 'update.sharing' : state.blocked === 'busy' ? 'update.busy' : 'update.unknown')}</p>}
      {state.notes && <details><summary>{t('update.notes')}</summary><pre>{state.notes}</pre></details>}
      <div className={css.buttons}>
        <button type="button" disabled={working || state.phase === 'restart-required'} onClick={() => void client.invoke('check')}>{t('update.check')}</button>
        {state.latest && <button type="button" disabled={working || Boolean(state.blocked) || state.error === 'incompatible' || state.phase === 'restart-required'} onClick={() => void client.invoke('installUpdate')}>{t('update.install')}</button>}
      </div>
      <label className={css.option}><input type="checkbox" checked={state.auto} disabled={state.phase === 'installing'} onChange={event => void client.invoke('setAuto', event.target.checked)} />{t('update.auto')}</label>
      <p>{t('update.autoHint')}</p>
    </div>
  </details>
}
