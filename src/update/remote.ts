import { z } from 'zod'
import { updateConfig as config } from './config.ts'
const state = z.object({ current:z.string(), latest:z.string().nullable(), notes:z.string(), url:z.string(), auto:z.boolean(), checkedAt:z.number(), phase:z.string(), error:z.string(), blocked:z.string() })
const declarations: any[] = [
  ['status', [], state], ['check', [], state], ['installUpdate', [], state],
  ['setAuto', [['enabled', z.boolean()]], state],
  ['heartbeat', [['id', z.string().min(1).max(80)], ['blocked', z.boolean()], ['open', z.boolean()]], state],
  ['releaseClient', [['id', z.string().min(1).max(80)]], z.boolean()],
]
export const descriptors = declarations.map(([method, parameters, result]) => ({
  id:`${config.package}#${config.service}/${method}`, service:config.service, namespace:config.service, method,
  invocation:{kind:'direct'}, parameters:parameters.map(([name, schema]) => ({name, wire:name, source:'json', codec:{mode:'strict',typeSymbol:`${config.package}#update:${method}:${name}`,create:()=>schema}})),
  result:{mode:'strict',typeSymbol:`${config.package}#update:${method}:result`,create:()=>result},
}))
export const updateRemote = {package:config.package, descriptors}
