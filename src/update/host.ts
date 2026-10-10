import { Service } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { Updater } from './core.ts'
import { discover, installRelease, runtimeVersion } from './releases.ts'
import { updateConfig as config } from './config.ts'
const domain = defineDomain({name:config.domain,version:1,layout:'per-record',tables:{settings:domainTable(z.boolean())}})
export class PluginUpdater extends TypertRemoteService {
  static inject = ['typert', 'storageDomain', 'pluginManager']
  updater!: Updater
  abort = new AbortController()
  constructor(ctx) { super(ctx, config.service) }
  async [Service.init]() {
    const storage = await this.ctx.storageDomain.open(domain), table = storage.table('settings')
    this.updater = new Updater(config.version, {
      now:Date.now, runtimeVersion:await runtimeVersion(),
      discover:() => discover(AbortSignal.any([this.abort.signal, AbortSignal.timeout(20_000)])),
      install:(release, allowed) => installRelease(release, AbortSignal.any([this.abort.signal, AbortSignal.timeout(120_000)]), allowed, this.ctx.pluginManager),
      saveAuto:enabled => table.put('auto', enabled),
      blocked:() => {
        if (config.service === 'pokerUpdates') {
          const bridge = this.ctx.get('pokerBridge')
          if (bridge?.gateway || bridge?.advertiser) return 'sharing'
          if (bridge?.sockets?.size || bridge?.aborts?.size) return 'busy'
        }
        return ''
      },
    })
    this.updater.state.auto = await table.get('auto') ?? false
    this.ctx.effect(() => {
      const timer = setInterval(() => { void this.updater.tick().catch(() => {}) }, 30_000)
      timer.unref()
      void this.updater.check()
      return async () => { clearInterval(timer); this.updater.dispose(); this.abort.abort(); await storage.close() }
    }, 'plugin updater: timer, downloads and preferences')
  }
  @Remote status() { return this.updater.status() }
  @Remote check() { return this.updater.check() }
  @Remote installUpdate() { return this.updater.install() }
  @Remote setAuto(enabled) { return this.updater.setAuto(enabled) }
  @Remote heartbeat(id, blocked, open) { return this.updater.heartbeat(id, blocked, open) }
  @Remote releaseClient(id) { return this.updater.releaseClient(id) }
}
