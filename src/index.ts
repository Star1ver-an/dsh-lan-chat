/** Independently installable Host composition; owns all chat contributions. */
import s from '@deepseek-ai/schemastery'
import { ChatRuntime } from './chat/index.ts'
import { ChatLan } from './lan/index.ts'
import ChatController from './controller/index.ts'
import * as commands from './commands/index.ts'
import * as tools from './tools/index.ts'
import { PluginUpdater } from './update/host.ts'

export const inject = ['agents', 'storageDomain', 'sessionProjections', 'typert', 'commands', 'tools']
export const Config = s.object({
  injectInto: s.union(['latest', 'none']).default('latest'),
  maxMessageChars: s.number().step(1).min(1).default(4000),
  displayName: s.string(),
  tools: s.boolean().default(true),
  lan: ChatLan.Config.default({}),
})

export function apply(ctx, config) {
  ctx.plugin(PluginUpdater)
  ctx.plugin(ChatRuntime, config)
  ctx.plugin(ChatLan, config.lan)
  ctx.plugin(ChatController)
  ctx.plugin(commands)
  if (config.tools) ctx.plugin(tools)
}
