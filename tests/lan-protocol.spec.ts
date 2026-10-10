import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ChatMessageId, PeerId } from '@deepseek-ai/dsh-chat'
import { decodeFrame, encodeFrame, PROTOCOL_VERSION } from '../src/lan/protocol.ts'
import type { LanFrame } from '../src/lan/protocol.ts'

const peer = (value: string): PeerId => brandString<PeerId>(value)
const mid = (value: string): ChatMessageId => brandString<ChatMessageId>(value)

const frames: Record<string, LanFrame> = {
  announce: { v: PROTOCOL_VERSION, kind: 'announce', peerId: peer('p1'), displayName: 'Peer One', tcpPort: 43001 },
  'pair-request': { v: PROTOCOL_VERSION, kind: 'pair-request', peerId: peer('p1'), displayName: 'Peer One' },
  'pair-response': { v: PROTOCOL_VERSION, kind: 'pair-response', peerId: peer('p1'), accept: true },
  message: { v: PROTOCOL_VERSION, kind: 'message', peerId: peer('p1'), messageId: mid('m1'), text: 'hello', sentAt: 5 },
  ack: { v: PROTOCOL_VERSION, kind: 'ack', peerId: peer('p1'), messageId: mid('m1'), accepted: false },
}

describe('frame codec', () => {
  it('round-trips every frame kind', () => {
    for (const frame of Object.values(frames)) {
      const line = encodeFrame(frame)
      expect(line.endsWith('\n')).toBe(true)
      expect(decodeFrame(line)).toEqual(frame)
    }
  })

  it('reports unparseable lines as malformed', () => {
    expect(decodeFrame('not json')).toBe('malformed')
    expect(decodeFrame('')).toBe('malformed')
    expect(decodeFrame('42')).toBe('malformed')
    expect(decodeFrame('null')).toBe('malformed')
    expect(decodeFrame('"text"')).toBe('malformed')
  })

  it('reports objects without the current version as stale', () => {
    expect(decodeFrame('{}')).toBe('stale-version')
    expect(decodeFrame(JSON.stringify({ ...frames.announce, v: 99 }))).toBe('stale-version')
  })

  it('reports unknown kinds as malformed', () => {
    expect(decodeFrame(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'ping' }))).toBe('malformed')
  })

  it('validates announce fields', () => {
    const base = JSON.stringify(frames.announce)
    expect(decodeFrame(base.replace('"p1"', '42'))).toBe('malformed')
    expect(decodeFrame(base.replace('"Peer One"', 'false'))).toBe('malformed')
    expect(decodeFrame(base.replace('43001', '-1'))).toBe('malformed')
    expect(decodeFrame(base.replace('43001', '1.5'))).toBe('malformed')
  })

  it('validates pair-request fields', () => {
    const line = JSON.stringify(frames['pair-request'])
    expect(decodeFrame(line.replace('"p1"', '{}'))).toBe('malformed')
    expect(decodeFrame(line.replace('"Peer One"', '7'))).toBe('malformed')
  })

  it('validates pair-response fields', () => {
    const line = JSON.stringify(frames['pair-response'])
    expect(decodeFrame(line.replace('"p1"', 'null'))).toBe('malformed')
    expect(decodeFrame(line.replace('true', '"yes"'))).toBe('malformed')
  })

  it('validates message fields', () => {
    const line = JSON.stringify(frames.message)
    expect(decodeFrame(line.replace('"m1"', '[]'))).toBe('malformed')
    expect(decodeFrame(line.replace('"hello"', '0'))).toBe('malformed')
    expect(decodeFrame(line.replace(':5}', ':true}'))).toBe('malformed')
  })

  it('validates ack fields', () => {
    const line = JSON.stringify(frames.ack)
    expect(decodeFrame(line.replace('"p1"', 'true'))).toBe('malformed')
    expect(decodeFrame(line.replace('"m1"', '9'))).toBe('malformed')
    expect(decodeFrame(line.replace('false', '1'))).toBe('malformed')
  })
})
