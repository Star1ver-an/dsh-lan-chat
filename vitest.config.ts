import { defineConfig } from 'vitest/config'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
const sdk = createRequire(resolve(process.env.DSH_RUNTIME ?? '.runtime/dsh/node_modules', '../package.json'))
export default defineConfig({
  plugins:[{name:'official-sdk',enforce:'pre',resolveId(id){
    if(id==='@deepseek-ai/dsh-chat')return resolve('src/chat/index.ts')
    if(id.startsWith('@deepseek-ai/'))return sdk.resolve(id)
  }}],
  test:{include:['tests/**/*.spec.ts'],testTimeout:15000},
})
