/**
 * The LAN chat transport plugin (`ctx.chatLan`): UDP-broadcast peer discovery
 * plus TCP JSON-lines pairing and delivery over the local network, mounted
 * into the single transport slot of `ctx.chat`. Static `directPeers` targets
 * replace broadcast where UDP broadcast is unavailable (sandboxes, AP-isolated
 * Wi-Fi). Disabling the plugin leaves `ctx.chat` running transport-less, with
 * pairing and sending surfacing `transport-unavailable`.
 * @module @deepseek-ai/dsh-chat-lan
 */

import { Context, Service } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { LanTransport } from './transport.ts'
import { resolveLanConfig } from './config.ts'
import type { ChatLanConfig } from './config.ts'

export * from './config.ts'
export * from './protocol.ts'
export * from './transport.ts'

/**
 * The LAN transport plugin. Mount after (and because of) `@deepseek-ai/dsh-chat`;
 * `ChatLanConfig` fields are all optional and resolved against documented defaults.
 */
export class ChatLan extends Service {
  static inject = ['chat']

  static Config: s<ChatLanConfig> = s.object({
    enabled: s.boolean(),
    displayName: s.string(),
    discoveryPort: s.number().step(1).min(0).max(65535),
    transportPort: s.number().step(1).min(0).max(65535),
    bindAddress: s.string(),
    broadcastAddress: s.string(),
    presenceIntervalMs: s.number().step(1).min(10),
    presenceTtlMs: s.number().step(1).min(50),
    requestTimeoutMs: s.number().step(1).min(10),
    directPeers: s.array(s.string()),
  })

  private readonly raw: ChatLanConfig
  private transportValue: LanTransport | undefined

  constructor(ctx: Context, config: ChatLanConfig) {
    super(ctx, 'chatLan')
    this.raw = config
  }

  protected async [Service.init](): Promise<void> {
    const config = resolveLanConfig(this.raw)
    if (!config.enabled) return
    if (config.displayName !== undefined) await this.ctx.chat.setDisplayName(config.displayName)
    const transport = new LanTransport({
      self: () => this.ctx.chat.identity,
      config,
      host: this.ctx.chat.host,
      warn: (message) => { this.ctx.logger.warn(`dsh-chat-lan: ${message}`) },
    })
    await this.ctx.chat.registerTransport(transport)
    this.transportValue = transport
    this.ctx.effect(() => async () => { await transport.stop() }, 'dsh-chat-lan.stop')
  }

  /** The transport this plugin mounted, or undefined while disabled or not yet started. */
  get transport(): LanTransport | undefined {
    return this.transportValue
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    chatLan: ChatLan
  }
}

export default ChatLan
