/**
 * The chat storage-domain declaration: record schemas and the `defineDomain`
 * spec the runtime opens. The zod schemas validate the shipped format at the
 * durability boundary; `per-record` layout gives every message and friend its
 * own version-stamped document, so the append-heavy message table never
 * rewrites unrelated records and the domain routes to either shipped backend.
 * @module @deepseek-ai/dsh-chat/src/domain
 */

import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { ChatMessageId, PeerId } from './brand.ts'
import type { ChatIdentity, ChatMessageRecord, FriendRecord } from './types.ts'

/** Current format version of the `chat` storage domain. */
export const CHAT_DOMAIN_VERSION = 1

/** The `meta` table's single key, holding this home's chat identity. */
export const IDENTITY_KEY = 'identity'

/** Peer-id schema at the durable boundary; branding has no runtime representation. */
const peerIdSchema = z.string().min(1).transform(value => brandString<PeerId>(value))

/** Message-id schema at the durable boundary; branding has no runtime representation. */
const messageIdSchema = z.string().min(1).transform(value => brandString<ChatMessageId>(value))

/** Non-negative epoch-millisecond schema shared by every stored timestamp. */
const epochMsSchema = z.number().int().nonnegative()

/**
 * Record schemas validate stored records, not construction-time arguments
 * (the runtime builds records itself), so they stay open objects: a future
 * format version may add optional fields and `compatibleVersions` lets older
 * records through without a `strict` rejection.
 */

// Zod infers transformed branded fields structurally, so it cannot name the
// public interface even though every branded output is created below.
function domainSchema<T>(schema: z.ZodType): z.ZodType<T> {
  return schema as z.ZodType<T>
}

/** Schema for the home identity stored as the domain's single meta record. */
export const chatIdentitySchema = domainSchema<ChatIdentity>(z.object({
  peerId: peerIdSchema,
  displayName: z.string().min(1),
}))

/** Stored friend record: one accepted pairing, version-stamped per record. */
/** Schema for one version-stamped accepted-pairing record. */
export const friendRecordSchema = domainSchema<FriendRecord>(z.object({
  peerId: peerIdSchema,
  displayName: z.string().min(1),
  pairedAt: epochMsSchema,
  fingerprint: z.string(),
}))

/** Stored message record: one delivered message, version-stamped per record. */
/** Schema for one version-stamped delivered-message record. */
export const chatMessageRecordSchema = domainSchema<ChatMessageRecord>(z.object({
  messageId: messageIdSchema,
  peerId: peerIdSchema,
  direction: z.union([z.literal('in'), z.literal('out')]),
  text: z.string(),
  sentAt: epochMsSchema,
  deliveredAt: epochMsSchema,
}))

/**
 * The `chat` storage domain: this home's identity under the single
 * {@link IDENTITY_KEY} `meta` record, one `friends` record per accepted
 * pairing, and one `messages` record per delivered message.
 */
export const chatDomainSpec = defineDomain({
  name: 'chat',
  version: CHAT_DOMAIN_VERSION,
  layout: 'per-record',
  tables: {
    meta: domainTable<string, ChatIdentity>(chatIdentitySchema),
    friends: domainTable<PeerId, FriendRecord>(friendRecordSchema),
    messages: domainTable<ChatMessageId, ChatMessageRecord>(chatMessageRecordSchema),
  },
})
