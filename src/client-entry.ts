/** Mount the private Remote contribution without changing official api-remotes. */
import remote from './generated/chat.remote.js'
import * as ui from './client/index.ts'

export const inject = ['slots', 'locale', 'remote']
export async function apply(ctx) {
  const unmount = await ctx.remote.$mount(remote)
  ctx.effect(() => unmount, 'lan-chat: remote namespace')
  ctx.plugin(ui)
}
