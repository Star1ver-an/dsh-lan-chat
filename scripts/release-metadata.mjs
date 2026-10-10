/** Run after pnpm pack. Publish this file together with the immutable versioned archive. */
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
const archive = process.argv[2]
if (!archive) throw new Error('Usage: node scripts/release-metadata.mjs path/to/package.tgz')
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const expected = manifest.name.replace(/^@/, '').replace('/', '-') + '-' + manifest.version + '.tgz'
if (basename(archive) !== expected) throw new Error(`Expected archive ${expected}`)
const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex')
await writeFile(join(dirname(archive), 'update.json'), JSON.stringify({format:1, package:manifest.name,version:manifest.version,file:basename(archive),sha256,dshVersion:manifest.peerDependencies['@deepseek-ai/dsh-typert-protocol']}, null, 2) + '\n')
await writeFile(join(dirname(archive), 'SHA256SUMS.txt'), `${sha256}  ${basename(archive)}\n`)
