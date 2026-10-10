/**
 * Human slash commands over `ctx.chat`: `/friend` manages pairing and the
 * friend list (add / accept / decline / remove / rename, bare to list), and
 * `/msg` delivers one message to a friend without a model turn. `/msg` sets
 * `recordInput: false` because the chat domain already persists the message
 * payload, so the session log would duplicate it.
 * @module @deepseek-ai/dsh-command-chat
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { ChatError } from '@deepseek-ai/dsh-chat'
import type { PeerId } from '@deepseek-ai/dsh-chat'

export const name = 'command-chat'
export const inject = ['commands', 'chat']

const FRIEND_USAGE = 'Usage: /friend [add <peerId|name> | accept <peerId|name> | decline <peerId|name> | remove <peerId|name> | rename <peerId|name> <new name>]'
const MSG_USAGE = 'Usage: /msg <peerId|name> <message>'

/**
 * Resolve one `peerId|name` reference against candidate rows carrying a peer
 * id and a display name: an exact peer id wins, then a unique
 * case-insensitive display-name match.
 * @param rows - the candidates, each a peer id with a display name.
 * @param ref - the reference the user typed.
 * @returns the resolved peer id, or undefined when nothing matches uniquely.
 */
function resolveRef(rows: readonly { readonly peerId: PeerId; readonly displayName: string }[], ref: string): PeerId | undefined {
  const byId = rows.find(row => row.peerId === ref)
  if (byId !== undefined) return byId.peerId
  const needle = ref.toLowerCase()
  // Unique case-insensitive name match; a second hit means ambiguous.
  let unique: PeerId | undefined
  for (const row of rows) {
    if (row.displayName.toLowerCase() !== needle) continue
    if (unique !== undefined) return undefined
    unique = row.peerId
  }
  return unique
}

/** Split `rawInput` into the first whitespace-separated token and the remainder. */
function splitInput(rawInput: string): { head: string; tail: string } {
  const trimmed = rawInput.trim()
  const separator = trimmed.search(/\s/)
  if (separator < 0) return { head: trimmed, tail: '' }
  return { head: trimmed.slice(0, separator), tail: trimmed.slice(separator).trim() }
}

/** Render the bare `/friend` listing: friends, pending pairings, discovered peers. */
function listChat(ctx: Context): CommandResult {
  const chat = ctx.chat
  const lines: string[] = []
  const friends = chat.listFriends()
  if (friends.length > 0) {
    lines.push('Friends:')
    for (const view of friends) {
      lines.push(`  ${view.record.displayName} (${view.online ? 'online' : 'offline'}) — fingerprint ${view.record.fingerprint}`)
    }
  }
  const pending = chat.listPendingPairings()
  if (pending.length > 0) {
    lines.push('Pending pairings:')
    for (const record of pending) {
      lines.push(`  ${record.direction === 'incoming' ? '⇐ from' : '⇒ to'} ${record.displayName} — /friend ${record.direction === 'incoming' ? 'accept' : 'wait for'} ${record.displayName}`)
    }
  }
  const known = new Set(friends.map(view => view.record.peerId))
  const discovered = chat.listDiscoveredPeers().filter(peer => !known.has(peer.peerId))
  if (discovered.length > 0) {
    lines.push('Discovered peers (not paired):')
    for (const peer of discovered) {
      lines.push(`  ${peer.displayName} — /friend add ${peer.displayName}`)
    }
  }
  return { kind: 'success', text: lines.length > 0 ? lines.join('\n') : 'No friends, pending pairings, or discovered peers yet.' }
}

/** Execute one `/friend <subcommand>` line; every failure returns error copy. */
async function executeFriendCommand(invocation: CommandInvocation, ctx: Context): Promise<CommandResult> {
  const chat = ctx.chat
  const { head, tail } = splitInput(invocation.rawInput)
  if (head === '') return listChat(ctx)
  if (head === 'add') {
    if (tail === '') return { kind: 'error', text: `A peer is required. ${FRIEND_USAGE}` }
    const peerId = resolveRef(chat.listDiscoveredPeers(), tail)
    if (peerId === undefined) return { kind: 'error', text: `No discovered peer matches ${JSON.stringify(tail)}.` }
    await chat.requestPairing(peerId)
    return { kind: 'success', text: `Pairing request sent to ${tail}.` }
  }
  if (head === 'accept' || head === 'decline') {
    if (tail === '') return { kind: 'error', text: `A peer is required. ${FRIEND_USAGE}` }
    const incoming = chat.listPendingPairings().filter(record => record.direction === 'incoming')
    const peerId = resolveRef(incoming, tail)
    if (peerId === undefined) return { kind: 'error', text: `No incoming pairing request matches ${JSON.stringify(tail)}.` }
    await chat.respondPairing(peerId, head === 'accept')
    return { kind: 'success', text: head === 'accept' ? `Pairing with ${tail} accepted.` : `Pairing request from ${tail} declined.` }
  }
  if (head === 'remove') {
    if (tail === '') return { kind: 'error', text: `A friend is required. ${FRIEND_USAGE}` }
    const peerId = resolveRef(chat.listFriends().map(view => view.record), tail)
    if (peerId === undefined) return { kind: 'error', text: `No friend matches ${JSON.stringify(tail)}.` }
    const removed = await chat.removeFriend(peerId)
    return removed
      ? { kind: 'success', text: `Friend ${tail} removed.` }
      : { kind: 'error', text: `Friend ${tail} was already gone.` }
  }
  if (head === 'rename') {
    const { head: ref, tail: newName } = splitInput(tail)
    if (ref === '' || newName === '') return { kind: 'error', text: `A friend and a new name are required. ${FRIEND_USAGE}` }
    const peerId = resolveRef(chat.listFriends().map(view => view.record), ref)
    if (peerId === undefined) return { kind: 'error', text: `No friend matches ${JSON.stringify(ref)}.` }
    const record = await chat.renameFriend(peerId, newName)
    return { kind: 'success', text: `Friend renamed to ${record.displayName}.` }
  }
  return { kind: 'error', text: `Unknown /friend subcommand ${JSON.stringify(head)}. ${FRIEND_USAGE}` }
}

/** Execute one `/msg <friend> <text>` line. */
async function executeMsgCommand(invocation: CommandInvocation, ctx: Context): Promise<CommandResult> {
  const { head, tail } = splitInput(invocation.rawInput)
  if (head === '' || tail === '') return { kind: 'error', text: MSG_USAGE }
  const peerId = resolveRef(ctx.chat.listFriends().map(view => view.record), head)
  if (peerId === undefined) return { kind: 'error', text: `No friend matches ${JSON.stringify(head)}.` }
  await ctx.chat.send(peerId, tail)
  return { kind: 'success', text: `Delivered to ${head}.` }
}

/** Wrap one handler so a `ChatError` becomes command error copy instead of a throw. */
async function guardChat(handler: () => Promise<CommandResult>): Promise<CommandResult> {
  try {
    return await handler()
  } catch (error: unknown) {
    if (error instanceof ChatError) return { kind: 'error', text: error.message }
    throw error
  }
}

/** Register the `/friend` and `/msg` commands for every composed command adapter. */
export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'friend',
    description: 'list, add, accept, decline, remove, or rename chat friends',
    input: { hint: '[add|accept|decline|remove|rename] [peerId|name]' },
    handler: invocation => guardChat(() => executeFriendCommand(invocation, ctx)),
  })
  ctx.commands.register({
    name: 'msg',
    description: 'send a chat message to a friend without a model turn',
    input: { hint: '<peerId|name> <message>' },
    recordInput: false,
    handler: invocation => guardChat(() => executeMsgCommand(invocation, ctx)),
  })
}
