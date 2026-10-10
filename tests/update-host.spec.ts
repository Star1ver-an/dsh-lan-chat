import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { PluginUpdater } from '../src/update/host.ts'
import { updateConfig } from '../src/update/config.ts'
import * as releases from '../src/update/releases.ts'
it('starts its Host service, retains preferences across reload and cleans up timers',async()=>{
  vi.spyOn(releases,'discover').mockResolvedValue(null)
  const ctx = new Context()
  try {
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory',new MemoryStorageBackend(new MemoryMediaPool()))
    const facility=new DomainFacility(ctx,{backend:'memory',routes:{}})
    ctx.storage.mount('domain',facility);ctx.provide('storageDomain',facility);ctx.provide('typert',{} as never)
    ctx.provide('pluginManager',{installBundle:vi.fn()} as never)
    ctx.provide('pokerBridge',{sockets:new Map(),aborts:new Set()} as never)
    const fork=ctx.plugin(PluginUpdater);await fork
    const service=ctx.get(updateConfig.service) as PluginUpdater
    expect(service).toBeDefined()
    await service.setAuto(true)
    expect(service.status().auto).toBe(true)
    expect(service.heartbeat('test',false,false).blocked).toBe('')
    await fork.dispose()
    expect(service.updater.disposed).toBe(true)
    await ctx.plugin(PluginUpdater)
    expect((ctx.get(updateConfig.service) as PluginUpdater).status().auto).toBe(true)
  } finally { await ctx.fiber.dispose();vi.restoreAllMocks() }
})
