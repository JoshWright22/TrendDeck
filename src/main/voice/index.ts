import { ipcMain, session } from 'electron'
import { randomUUID } from 'node:crypto'
import { ID_PATTERN, partitionFor } from '@shared/types'
import {
  buildContext,
  cleanPost,
  IMPORT_PLATFORMS,
  mergePosts,
  type ImportPlatform,
  type VoiceContext,
  type VoiceData,
  type VoiceImportResult,
  type VoiceParts,
  type VoicePlatform,
  type VoicePost
} from '@shared/voice'
import { getData } from '../store'
import { readOwnPosts } from './importers'
import { dropVoice, loadVoice, saveVoice } from './store'

export { dropVoice }

// what the chat puts in front of every prompt: profile, summary and the best matching
// example posts, cut to fit budgetChars. the voice page previews this exact text
export async function getBrandContext(
  brandId: string,
  platform?: VoicePlatform,
  budgetChars?: number,
  parts?: VoiceParts
): Promise<VoiceContext> {
  const data = await loadVoice(brandId)
  const name = getData()?.brands.find((b) => b.id === brandId)?.name ?? 'this brand'
  return buildContext(name, data, platform, budgetChars ?? data.budget, parts ?? data.parts)
}

const importing = new Set<string>()

async function importOwn(
  brandId: string,
  platforms: ImportPlatform[]
): Promise<{ data: VoiceData; results: VoiceImportResult[] }> {
  if (importing.has(brandId)) throw new Error('already importing for this brand')
  importing.add(brandId)
  try {
    const ses = session.fromPartition(partitionFor(brandId))
    const start = await loadVoice(brandId)
    const results: VoiceImportResult[] = []
    const fresh: VoicePost[] = []
    // one site at a time, it's a few hidden pages and nobody is waiting on speed here
    for (const platform of platforms) {
      try {
        const found = await readOwnPosts(platform, ses, start.profile.handles[platform] ?? '')
        const posts = found
          .map((p) =>
            cleanPost({
              ...p,
              id: randomUUID(),
              platform,
              starred: false,
              tags: [],
              addedAt: Date.now(),
              source: 'import'
            })
          )
          .filter((p): p is VoicePost => p !== null)
        fresh.push(...posts)
        results.push({ platform, found: posts.length, added: 0 })
      } catch (err) {
        results.push({ platform, found: 0, added: 0, error: err instanceof Error ? err.message : String(err) })
      }
    }
    // reload in case the page saved while we were reading
    const now = await loadVoice(brandId)
    let posts = now.posts
    for (const r of results) {
      const merged = mergePosts(
        posts,
        fresh.filter((p) => p.platform === r.platform)
      )
      posts = merged.posts
      r.added = merged.added
    }
    const data = { ...now, posts }
    await saveVoice(brandId, data)
    return { data: await loadVoice(brandId), results }
  } finally {
    importing.delete(brandId)
  }
}

const okId = (id: unknown): id is string => typeof id === 'string' && ID_PATTERN.test(id)

export function setupVoice(): void {
  ipcMain.handle('voice:load', (_e, brandId: unknown) => {
    if (!okId(brandId)) throw new Error('bad brand id')
    return loadVoice(brandId)
  })
  ipcMain.handle('voice:save', (_e, brandId: unknown, data: unknown) => {
    if (!okId(brandId)) throw new Error('bad brand id')
    return saveVoice(brandId, data)
  })
  ipcMain.handle('voice:import', (_e, brandId: unknown, platforms: unknown) => {
    if (!okId(brandId)) throw new Error('bad brand id')
    const list = Array.isArray(platforms)
      ? IMPORT_PLATFORMS.filter((p) => platforms.includes(p))
      : []
    return importOwn(brandId, list)
  })
}
