import type { UpdateState } from './core.ts'
import { updateConfig } from './config.ts'
export class UpdateClient {
  state: UpdateState = { current:updateConfig.version, latest:null, notes:'', url:'', auto:false, checkedAt:0, phase:'idle', error:'', blocked:'unknown' }
  listeners = new Set<() => void>()
  id = crypto.randomUUID()
  blocked = true
  open = false
  operations = 0
  stopped = false
  timer: ReturnType<typeof setInterval> | undefined
  constructor(readonly remote: any) {}
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  async invoke(method: string, ...args: unknown[]) {
    if (this.stopped) return
    try {
      const result = await this.remote[method](...args)
      if (!result.ok) throw new Error('Update service unavailable')
      if (this.stopped) return
      this.state = result.value
    } catch {
      if (this.stopped) return
      this.state = { ...this.state, error:'service' }
    }
    for (const listener of this.listeners) listener()
  }
  heartbeat = () => this.invoke('heartbeat', this.id, this.blocked || this.operations > 0, this.open)
  safety(blocked: boolean, open: boolean) {
    if (this.blocked === blocked && this.open === open) return
    this.blocked = blocked; this.open = open; void this.heartbeat()
  }
  async during<T>(work: () => Promise<T>): Promise<T> {
    this.operations++; await this.heartbeat()
    try { return await work() } finally { this.operations--; void this.heartbeat() }
  }
  start() {
    void this.heartbeat()
    this.timer = setInterval(() => { void this.heartbeat() }, 15_000)
    return () => { this.stopped = true; clearInterval(this.timer); this.listeners.clear(); void this.remote.releaseClient(this.id).catch(() => {}) }
  }
}
