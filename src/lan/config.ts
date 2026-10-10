/**
 * User-tunable surface of the LAN transport: the raw (all-optional) config
 * the plugin receives, the fully resolved config the transport consumes, and
 * the single resolver that owns every default value.
 * @module @deepseek-ai/dsh-chat-lan/config
 */

/** One parsed `directPeers` entry: unicast-announce target. */
export interface DirectPeerTarget {
  readonly host: string
  readonly port: number
}

/**
 * Raw plugin config. Every field is optional; {@link resolveLanConfig} owns
 * the defaults. `discoveryPort` must be fixed (not ephemeral) on real LANs
 * because peers learn it out-of-band; `transportPort` may stay `0` because
 * announcements carry the served port.
 */
export interface ChatLanConfig {
  /** Mount the transport at all; disable to keep `ctx.chat` transport-less. */
  enabled?: boolean
  /** Override the chat identity's display name at boot. */
  displayName?: string
  /** UDP port announcements are sent to and bound on; `0` binds ephemeral. */
  discoveryPort?: number
  /** TCP port frame connections are served on; `0` serves ephemeral. */
  transportPort?: number
  /** Local bind address for both sockets. */
  bindAddress?: string
  /** Announce target for periodic broadcasts. */
  broadcastAddress?: string
  /** How often presence is announced, in ms. */
  presenceIntervalMs?: number
  /** How long a peer stays discovered without an announcement, in ms. */
  presenceTtlMs?: number
  /** Deadline for dials and delivery acks, in ms. */
  requestTimeoutMs?: number
  /** Static `host:port` peers to unicast-announce to, bypassing broadcast. */
  directPeers?: string[]
}

/** Resolved config: every field concrete, safe for the transport to read. */
export interface LanConfig extends Omit<ChatLanConfig, 'displayName' | 'directPeers'> {
  enabled: boolean
  displayName: string | undefined
  discoveryPort: number
  transportPort: number
  bindAddress: string
  broadcastAddress: string
  presenceIntervalMs: number
  presenceTtlMs: number
  requestTimeoutMs: number
  directPeers: readonly string[]
}

/**
 * Resolve the raw config against the documented defaults.
 * @param config - the plugin's raw, all-optional config.
 * @returns every field concrete, safe for the transport to read.
 */
export function resolveLanConfig(config: ChatLanConfig): LanConfig {
  return {
    enabled: config.enabled ?? true,
    displayName: config.displayName,
    discoveryPort: config.discoveryPort ?? 41888,
    transportPort: config.transportPort ?? 0,
    bindAddress: config.bindAddress ?? '0.0.0.0',
    broadcastAddress: config.broadcastAddress ?? '255.255.255.255',
    presenceIntervalMs: config.presenceIntervalMs ?? 3000,
    presenceTtlMs: config.presenceTtlMs ?? 9000,
    requestTimeoutMs: config.requestTimeoutMs ?? 5000,
    directPeers: config.directPeers ?? [],
  }
}

/**
 * Parse one `host:port` entry; the caller warns and skips a malformed entry.
 * @param raw - one `directPeers` element.
 * @returns the parsed target, or undefined when the entry is malformed.
 */
export function parseDirectPeer(raw: string): DirectPeerTarget | undefined {
  const separator = raw.lastIndexOf(':')
  if (separator <= 0 || separator === raw.length - 1) return undefined
  const host = raw.slice(0, separator)
  const port = Number(raw.slice(separator + 1))
  if (host.length === 0 || !Number.isInteger(port) || port <= 0 || port > 65535) return undefined
  return { host, port }
}
