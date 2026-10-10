import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { newer, type Release } from './core.ts'
import { updateConfig as config } from './config.ts'

export async function runtimeVersion() {
  try {
    const entry = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-plugin-manager')
    return JSON.parse(await readFile(join(dirname(entry), '../package.json'), 'utf8')).version as string
  } catch { return 'unknown' }
}
export async function readURL(url: string, limit: number, signal: AbortSignal, fetcher = fetch): Promise<Buffer> {
  let current = new URL(url)
  for (let redirects = 0; redirects < 5; redirects++) {
    if (current.protocol !== 'https:' || !['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(current.hostname) || current.username || current.password) throw new Error('Untrusted release host')
    const response = await fetcher(current, { signal, redirect: 'manual', headers: { 'User-Agent': 'DSH-local-plugin-updater', Accept: 'application/vnd.github+json' } })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location'); await response.body?.cancel()
      if (!location) throw new Error('Missing redirect')
      current = new URL(location, current); continue
    }
    if (!response.ok || !response.body) throw new Error('Release unavailable')
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0
    try {
      while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > limit) throw new Error('Release too large'); chunks.push(part.value) }
    } finally { await reader.cancel() }
    return Buffer.concat(chunks)
  }
  throw new Error('Too many redirects')
}
export async function discover(signal: AbortSignal): Promise<Release | null> {
  const release = JSON.parse((await readURL(`https://api.github.com/repos/${config.repository}/releases/latest`, 1_000_000, signal)).toString())
  const version = String(release.tag_name ?? '').replace(/^v/, '')
  if (release.draft || release.prerelease || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid release')
  if (!newer(version, config.version)) return null
  const root = `https://github.com/${config.repository}/releases/download/v${version}`
  const metadata = JSON.parse((await readURL(`${root}/update.json`, 32_000, signal)).toString())
  const filename = `${config.asset}-${version}.tgz`
  if (metadata.format !== 1 || metadata.package !== config.package || metadata.version !== version || metadata.file !== filename || !/^[a-f0-9]{64}$/.test(metadata.sha256) || typeof metadata.dshVersion !== 'string') throw new Error('Invalid metadata')
  return { version, notes: String(release.body ?? '').slice(0, 8000), url: `https://github.com/${config.repository}/releases/tag/v${version}`, asset: `${root}/${filename}`, sha256: metadata.sha256, dshVersion: metadata.dshVersion }
}
export async function installRelease(release: Release, signal: AbortSignal, allowed: () => boolean, manager: any) {
  const bytes = await readURL(release.asset, 30_000_000, signal)
  if (createHash('sha256').update(bytes).digest('hex') !== release.sha256) throw new Error('Checksum mismatch')
  if (!allowed() || signal.aborted) throw new Error('Update deferred')
  // Keep the source archive: pnpm records this path in the profile manifest/lockfile.
  const directory = join(homedir(), '.dsh', 'plugin-update-cache', config.asset)
  await mkdir(directory, { recursive: true })
    const filename = join(directory, `${config.asset}-${release.version}.tgz`)
    await writeFile(filename + '.download', bytes)
    await rename(filename + '.download', filename)
    if (!allowed() || signal.aborted) throw new Error('Update deferred')
    const result = await manager.installBundle(filename, { enabled: true })
    if (result.error || !['applied', 'restart-required'].includes(result.application)) throw new Error('Installation failed')
    return result.application as 'applied' | 'restart-required'
}
