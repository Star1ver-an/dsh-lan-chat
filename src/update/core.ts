/** Release discovery and installation policy; no user-supplied URL or version is executable. */
export type Release = { version: string; notes: string; url: string; asset: string; sha256: string; dshVersion: string }
export type UpdateState = { current: string; latest: string | null; notes: string; url: string; auto: boolean; checkedAt: number; phase: string; error: string; blocked: string }
export interface UpdatePorts {
  now(): number
  discover(): Promise<Release | null>
  install(release: Release, allowed: () => boolean): Promise<'applied' | 'restart-required'>
  saveAuto(enabled: boolean): Promise<void>
  blocked(): string
  runtimeVersion: string
}
export function newer(next: string, current: string): boolean {
  if (![next, current].every(v => /^\d+\.\d+\.\d+$/.test(v))) return false
  const a = next.split('.').map(Number), b = current.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!
  return false
}
export class Updater {
  state: UpdateState
  release: Release | null = null
  disposed = false
  clients = new Map<string, { blocked: boolean; open: boolean; at: number }>()
  idleSince = 0
  constructor(version: string, readonly ports: UpdatePorts) {
    this.state = { current: version, latest: null, notes: '', url: '', auto: false, checkedAt: 0, phase: 'idle', error: '', blocked: '' }
  }
  status() { return { ...this.state, blocked: this.blocked(false) } }
  blocked(auto: boolean) {
    if (this.disposed) return 'stopped'
    const host = this.ports.blocked()
    if (host) return host
    if (!this.clients.size || [...this.clients.values()].some(c => this.ports.now() - c.at > 60_000)) return 'unknown'
    if ([...this.clients.values()].some(c => c.blocked)) return 'busy'
    if (auto && [...this.clients.values()].some(c => c.open)) return 'open'
    return ''
  }
  heartbeat(id: string, blocked: boolean, open: boolean) {
    if (!this.clients.has(id) && this.clients.size >= 64) return this.status()
    this.clients.set(id, { blocked, open, at: this.ports.now() })
    if (this.blocked(true)) this.idleSince = 0
    else if (!this.idleSince) this.idleSince = this.ports.now()
    return this.status()
  }
  releaseClient(id: string) { this.clients.delete(id); this.idleSince = 0; return true }
  async setAuto(enabled: boolean) {
    await this.ports.saveAuto(enabled)
    this.state.auto = enabled
    this.idleSince = 0
    return this.status()
  }
  async check() {
    if (this.disposed || ['checking', 'installing', 'restart-required'].includes(this.state.phase)) return this.status()
    this.state.phase = 'checking'; this.state.error = ''
    try {
      const release = await this.ports.discover()
      if (this.disposed) return this.status()
      this.release = release && newer(release.version, this.state.current) ? release : null
      Object.assign(this.state, { checkedAt: this.ports.now(), latest: this.release?.version ?? null, notes: this.release?.notes ?? '', url: this.release?.url ?? '', phase: this.release ? 'available' : 'idle' })
      if (this.release && this.release.dshVersion !== this.ports.runtimeVersion) this.state.error = 'incompatible'
    } catch {
      this.release = null
      Object.assign(this.state, { phase: 'error', error: 'network', latest: null, checkedAt: this.ports.now() })
    }
    return this.status()
  }
  async install(auto = false) {
    if (this.disposed || !this.release || ['checking', 'installing', 'restart-required'].includes(this.state.phase)) return this.status()
    if (this.release.dshVersion !== this.ports.runtimeVersion) { this.state.error = 'incompatible'; return this.status() }
    if (this.blocked(auto) || (auto && (!this.state.auto || !this.idleSince || this.ports.now() - this.idleSince < 120_000))) return this.status()
    this.state.phase = 'installing'; this.state.error = ''
    try {
      // Downloading may take time: check every active window again immediately before installation.
      const result = await this.ports.install(this.release, () => !this.blocked(auto) && (!auto || this.state.auto))
      this.state.phase = result === 'applied' ? 'restart-required' : result
    } catch {
      if (!this.disposed) {
        const deferred = this.blocked(auto) || (auto && !this.state.auto)
        this.state.phase = deferred ? 'available' : 'error'
        this.state.error = deferred ? '' : 'install'
        this.idleSince = 0
      }
    }
    return this.status()
  }
  async tick() {
    if (!this.state.checkedAt || this.ports.now() - this.state.checkedAt >= 6 * 60 * 60_000) await this.check()
    // Automatic failures are not retried until the next check or explicit user action.
    if (this.state.auto && this.state.phase === 'available') await this.install(true)
  }
  dispose() { this.disposed = true; this.clients.clear() }
}
