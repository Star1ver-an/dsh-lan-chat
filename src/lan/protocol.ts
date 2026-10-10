/**
 * Wire vocabulary of the LAN transport: frame shapes, the JSON-lines codec,
 * and the protocol version gate. Every frame carries the sender's peer id and
 * the protocol version; frames with a foreign version are ignored and counted
 * so mixed-fleet LANs degrade to silence instead of garbage.
 * @module @deepseek-ai/dsh-chat-lan/protocol
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import type { ChatMessageId, PeerId } from '@deepseek-ai/dsh-chat'

/** Current LAN protocol version; frames carrying any other version are ignored. */
export const PROTOCOL_VERSION = 1

/** Periodic presence beacon, one UDP datagram per announcement. */
export interface AnnounceFrame {
  readonly v: typeof PROTOCOL_VERSION
  readonly kind: 'announce'
  /** The announcing peer. */
  readonly peerId: PeerId
  /** The announcing peer's display name. */
  readonly displayName: string
  /** The TCP port the announcer serves frames on. */
  readonly tcpPort: number
}

/** A pairing request, one TCP line from requester to requestee. */
export interface PairRequestFrame {
  readonly v: typeof PROTOCOL_VERSION
  readonly kind: 'pair-request'
  readonly peerId: PeerId
  readonly displayName: string
}

/** A pairing decision, one TCP line from responder back to requester. */
export interface PairResponseFrame {
  readonly v: typeof PROTOCOL_VERSION
  readonly kind: 'pair-response'
  readonly peerId: PeerId
  readonly accept: boolean
}

/** One chat message, one TCP line from sender to recipient. */
export interface MessageFrame {
  readonly v: typeof PROTOCOL_VERSION
  readonly kind: 'message'
  readonly peerId: PeerId
  readonly messageId: ChatMessageId
  readonly text: string
  readonly sentAt: number
}

/** A delivery decision for one message, one TCP line from recipient back to sender. */
export interface AckFrame {
  readonly v: typeof PROTOCOL_VERSION
  readonly kind: 'ack'
  readonly peerId: PeerId
  readonly messageId: ChatMessageId
  readonly accepted: boolean
}

/** Every frame the LAN wire carries; each kind carries the sender's peer id. */
export type LanFrame = AnnounceFrame | PairRequestFrame | PairResponseFrame | MessageFrame | AckFrame

/** The `kind` discriminant shared by every frame. */
export type FrameKind = LanFrame['kind']

/** Why one line could not become a frame. */
export type DecodeFailure = 'malformed' | 'stale-version'

/**
 * Encode one frame as a terminated JSON line.
 * @param frame - the frame to encode.
 * @returns the newline-terminated JSON line to write.
 */
export function encodeFrame(frame: LanFrame): string {
  return `${JSON.stringify(frame)}\n`
}

/**
 * Decode one JSON line into a frame. Returns `'malformed'` for unparseable or
 * wrongly-shaped lines, `'stale-version'` for a foreign protocol version, and
 * otherwise the typed frame.
 * @param line - one received line, without its terminator.
 * @returns the typed frame, or the reason the line was dropped.
 */
export function decodeFrame(line: string): LanFrame | DecodeFailure {
  let data: unknown
  try {
    data = JSON.parse(line)
  } catch {
    return 'malformed'
  }
  if (typeof data !== 'object' || data === null) return 'malformed'
  const record = data as Record<string, unknown>
  if (record.v !== PROTOCOL_VERSION) return 'stale-version'
  switch (record.kind) {
    case 'announce': {
      if (!isText(record.peerId) || !isText(record.displayName) || !isPort(record.tcpPort)) return 'malformed'
      return {
        v: PROTOCOL_VERSION,
        kind: 'announce',
        peerId: brandString<PeerId>(record.peerId),
        displayName: record.displayName,
        tcpPort: record.tcpPort,
      }
    }
    case 'pair-request': {
      if (!isText(record.peerId) || !isText(record.displayName)) return 'malformed'
      return {
        v: PROTOCOL_VERSION,
        kind: 'pair-request',
        peerId: brandString<PeerId>(record.peerId),
        displayName: record.displayName,
      }
    }
    case 'pair-response': {
      if (!isText(record.peerId) || typeof record.accept !== 'boolean') return 'malformed'
      return {
        v: PROTOCOL_VERSION,
        kind: 'pair-response',
        peerId: brandString<PeerId>(record.peerId),
        accept: record.accept,
      }
    }
    case 'message': {
      if (!isText(record.peerId) || !isText(record.messageId) || !isText(record.text) || typeof record.sentAt !== 'number') return 'malformed'
      return {
        v: PROTOCOL_VERSION,
        kind: 'message',
        peerId: brandString<PeerId>(record.peerId),
        messageId: brandString<ChatMessageId>(record.messageId),
        text: record.text,
        sentAt: record.sentAt,
      }
    }
    case 'ack': {
      if (!isText(record.peerId) || !isText(record.messageId) || typeof record.accepted !== 'boolean') return 'malformed'
      return {
        v: PROTOCOL_VERSION,
        kind: 'ack',
        peerId: brandString<PeerId>(record.peerId),
        messageId: brandString<ChatMessageId>(record.messageId),
        accepted: record.accepted,
      }
    }
    default:
      return 'malformed'
  }
}

function isText(value: unknown): value is string {
  return typeof value === 'string'
}

function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}
