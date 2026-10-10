import { build } from 'esbuild'
import { transform } from 'lightningcss'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'

const runtime = resolve(process.env.DSH_RUNTIME ?? '.runtime/dsh/node_modules')
const localChat = resolve('src/chat')
const platform = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives']

function resolver(browser) {
  return { name: 'dsh-sdk', setup(b) {
    b.onResolve({filter: /^@deepseek-ai\//}, args => {
      if (args.pluginData?.resolved) return
      if (args.path === '@deepseek-ai/dsh-chat') return {path: resolve(localChat, 'index.ts')}
      if (args.path.startsWith('@deepseek-ai/dsh-chat/')) return {path: resolve(localChat, args.path.split('/').at(-1) + '.ts')}
      if (!browser || platform.includes(args.path)) return {path: args.path, external: true}
      return b.resolve(args.path, {resolveDir: resolve(runtime, '..'), kind: args.kind, pluginData: {resolved: true}})
    })
  }}
}

function cssModules(styles) {
  return {name:'styles', setup(b) {
    b.onLoad({filter:/\.module\.css$/}, async args => {
      const css = transform({filename:args.path,code:await readFile(args.path),cssModules:{pattern:'[hash]_[local]'},minify:true})
      styles.push(css.code.toString())
      return {contents:`export default ${JSON.stringify(Object.fromEntries(Object.entries(css.exports).map(([k,v])=>[k,v.name])))}`,loader:'js'}
    })
  }}
}

{
  const folder = 'lan-chat'
  const root = resolve('.')
  const manifest = JSON.parse(await readFile(resolve(root,'package.json'),'utf8'))
  await mkdir(resolve(root,'lib'),{recursive:true})
  const base = {bundle:true,logLevel:'info',target:'es2022',nodePaths:[runtime],tsconfigRaw:{compilerOptions:{jsx:'react-jsx'}}}
  const typert = 'src/typert.ts'
  for (const [entry,out] of [['src/index.ts','index.js'],[typert,'typert.js']]) {
    await build({...base,entryPoints:[resolve(root,entry)],outfile:resolve(root,'lib',out),platform:'node',format:'esm',banner:{js:'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);'},plugins:[resolver(false)]})
  }
  const styles=[]
  const client=await build({...base,entryPoints:[resolve(root,'src/client-entry.ts')],write:false,platform:'browser',format:'cjs',external:platform,plugins:[resolver(true),cssModules(styles)],define:{'process.env.NODE_ENV':'"production"'}})
  const wrap=`window.__ModuleLoader__.load({id:${JSON.stringify(manifest.name)},factory:(require)=>{\nvar module={exports:{}};var exports=module.exports;\n${client.outputFiles[0].text}\nconst original=module.exports.apply;return {...module.exports,apply(ctx,config){ctx.effect(()=>{const style=document.createElement('style');style.dataset.plugin=${JSON.stringify(manifest.name)};style.textContent=${JSON.stringify(styles.join('\n'))};document.head.appendChild(style);return ()=>style.remove();},'plugin styles');return original(ctx,config);}};}});\n`
  await writeFile(resolve(root,'lib/client.js'),wrap)
}
