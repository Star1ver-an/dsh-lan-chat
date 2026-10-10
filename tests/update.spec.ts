import { expect, it, vi } from 'vitest'
import { Updater, newer, type Release } from '../src/update/core.ts'
import { readURL, installRelease, discover } from '../src/update/releases.ts'
import { updateConfig } from '../src/update/config.ts'
const release:Release = {version:'1.2.0',notes:'New feature',url:'https://github.com/Star1ver-an/example/releases/tag/v1.2.0',asset:'unused',sha256:'a'.repeat(64),dshVersion:'0.2.0-rc.2'}
function bench() {
  let now = 1000, blocked = ''
  const ports = {now:()=>now,blocked:()=>blocked,runtimeVersion:'0.2.0-rc.2',discover:vi.fn(async()=>release),saveAuto:vi.fn(async()=>{}),install:vi.fn(async (_release, allowed) => {if (!allowed()) throw new Error('busy'); return 'restart-required' as const})}
  const updater = new Updater('1.1.9', ports)
  const heartbeat = (busy=false,open=false) => updater.heartbeat('window',busy,open)
  return {updater,ports,heartbeat,advance:(ms:number)=>{now+=ms},block:(value:string)=>{blocked=value}}
}
it('compares numeric stable versions without accepting arbitrary tags',()=>{
  expect(newer('1.10.0','1.9.0')).toBe(true)
  for(const value of ['1.9.0','1.8.9','v2.0.0','2.0.0-beta.1','../../update'])expect(newer(value,'1.9.0')).toBe(false)
})
it('checks on startup and every six hours, but automatic installation is opt-in',async()=>{
  const b=bench(); b.heartbeat(); await b.updater.tick()
  expect(b.updater.status()).toMatchObject({latest:'1.2.0',auto:false,phase:'available'})
  await b.updater.tick();expect(b.ports.discover).toHaveBeenCalledTimes(1)
  b.advance(6*60*60_000);await b.updater.tick();expect(b.ports.discover).toHaveBeenCalledTimes(2)
  expect(b.ports.install).not.toHaveBeenCalled()
})
it('automatically installs only after two minutes of verified idle time',async()=>{
  const b=bench(); await b.updater.setAuto(true); b.heartbeat(); await b.updater.check()
  for(let n=0;n<4;n++){b.advance(30_000);b.heartbeat();await b.updater.tick()}
  expect(b.ports.install).toHaveBeenCalledTimes(1)
  expect(b.updater.status().phase).toBe('restart-required')
  await b.updater.tick();expect(b.ports.install).toHaveBeenCalledTimes(1)
})
it('blocks unknown windows, drafts, open panels, stale leases and host sharing',async()=>{
  const b=bench();await b.updater.check();await b.updater.install();expect(b.ports.install).not.toHaveBeenCalled()
  b.heartbeat(true);await b.updater.install();expect(b.updater.status().blocked).toBe('busy')
  b.heartbeat(false);b.block('sharing');await b.updater.install();expect(b.updater.status().blocked).toBe('sharing')
  b.block('');b.advance(61_000);await b.updater.install();expect(b.updater.status().blocked).toBe('unknown')
  b.heartbeat(false,true);await b.updater.setAuto(true);b.advance(120_000);b.heartbeat(false,true);await b.updater.tick();expect(b.ports.install).not.toHaveBeenCalled()
  // Manual installation is allowed with the settings panel open, once business activity has stopped.
  await b.updater.install();expect(b.ports.install).toHaveBeenCalledTimes(1)
})
it('checks all windows and checks activity again after downloading',async()=>{
  const b=bench();b.heartbeat();b.updater.heartbeat('second',true,false);await b.updater.check();await b.updater.install();expect(b.ports.install).not.toHaveBeenCalled()
  b.updater.releaseClient('second')
  b.ports.install.mockImplementation(async(_r,allowed)=>{b.heartbeat(true);expect(allowed()).toBe(false);throw new Error('deferred')})
  await b.updater.install();expect(b.updater.status()).toMatchObject({phase:'available',error:'',blocked:'busy'})
})
it('does not install incompatible releases, downgrade, or immediately retry automatic failures',async()=>{
  const b=bench(); b.heartbeat(); b.ports.runtimeVersion='new-dsh';await b.updater.check();await b.updater.install();expect(b.updater.status().error).toBe('incompatible');expect(b.ports.install).not.toHaveBeenCalled()
  b.ports.runtimeVersion='0.2.0-rc.2';b.ports.discover.mockResolvedValue({...release,version:'1.0.0'});await b.updater.check();expect(b.updater.status().latest).toBeNull()
  b.ports.discover.mockResolvedValue(release);await b.updater.check();await b.updater.setAuto(true);b.heartbeat()
  for(let n=0;n<4;n++){b.advance(30_000);b.heartbeat()}
  b.ports.install.mockRejectedValue(new Error('network'));await b.updater.tick();await b.updater.tick();expect(b.ports.install).toHaveBeenCalledTimes(1)
})
it('preserves opt-in only after durable storage succeeds and stops work after disposal',async()=>{
  const b=bench();b.ports.saveAuto.mockRejectedValue(new Error('disk'));await expect(b.updater.setAuto(true)).rejects.toThrow();expect(b.updater.status().auto).toBe(false)
  b.updater.dispose();await b.updater.tick();expect(b.ports.discover).not.toHaveBeenCalled()
})
it('rejects external redirects and oversized downloads',async()=>{
  const fetcher=vi.fn(async()=>new Response(null,{status:302,headers:{location:'https://untrusted.example/plugin.tgz'}}))
  await expect(readURL('https://github.com/owner/repo/file',100,new AbortController().signal,fetcher as any)).rejects.toThrow('Untrusted')
  expect(fetcher).toHaveBeenCalledTimes(1)
  await expect(readURL('https://github.com/owner/repo/file',2,new AbortController().signal,async()=>new Response('too large'))).rejects.toThrow('too large')
})
it('rejects a mismatched archive before calling the package manager',async()=>{
  const manager = {installBundle:vi.fn()}
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('tampered archive')))
  try {
    await expect(installRelease({...release,asset:'https://github.com/owner/repo/file'},new AbortController().signal,()=>true,manager)).rejects.toThrow('Checksum')
    expect(manager.installBundle).not.toHaveBeenCalled()
  } finally { vi.unstubAllGlobals() }
})
it('binds release metadata to the exact configured plugin and version',async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce(Response.json({tag_name:'v99.0.0',body:'Notes',draft:false,prerelease:false})).mockResolvedValueOnce(Response.json({format:1,package:'@someone/another-plugin',version:'99.0.0',file:`${updateConfig.asset}-99.0.0.tgz`,sha256:'a'.repeat(64),dshVersion:'0.2.0-rc.2'}))
  vi.stubGlobal('fetch',fetcher)
  try { await expect(discover(new AbortController().signal)).rejects.toThrow('Invalid metadata') }
  finally { vi.unstubAllGlobals() }
})
