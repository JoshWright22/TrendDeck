import type { Brand } from '@shared/types'
import { ToolError, type GatewayTool } from '../types'
import { list, obj, str } from '../validate'
import { brandOf, changeBrand } from './common'

// the brand itself for the agent: its name and niche keywords. folders on disk don't move on a
// rename, the store keeps the one the brand already had, see keepBrandFolders in main/store.ts

export const BRAND_NAME_MAX = 60
export const KEYWORDS_MAX = 30
export const KEYWORD_MAX = 60

export interface BrandPatch {
  name?: string
  keywords?: string[]
}

// what brand_update changes, checked. pure, unit tested
export function cleanBrandUpdate(args: Record<string, unknown>): BrandPatch {
  const out: BrandPatch = {}
  if (args.name !== undefined) {
    const name = String(args.name).replace(/\s+/g, ' ').trim()
    if (!name) throw new ToolError("the brand name can't be empty")
    if (name.length > BRAND_NAME_MAX) throw new ToolError(`the brand name can be at most ${BRAND_NAME_MAX} characters, that one is ${name.length}`)
    out.name = name
  }
  if (args.keywords !== undefined) {
    const raw = Array.isArray(args.keywords) ? args.keywords : []
    const seen = new Set<string>()
    const keywords: string[] = []
    for (const k of raw) {
      const word = String(k).replace(/\s+/g, ' ').trim()
      if (!word) continue
      if (word.length > KEYWORD_MAX) throw new ToolError(`each keyword can be at most ${KEYWORD_MAX} characters, "${word.slice(0, 40)}..." is longer`)
      if (seen.has(word.toLowerCase())) continue
      seen.add(word.toLowerCase())
      keywords.push(word)
    }
    if (keywords.length > KEYWORDS_MAX) throw new ToolError(`at most ${KEYWORDS_MAX} keywords, that is ${keywords.length}. keep the ones that matter most`)
    out.keywords = keywords
  }
  if (out.name === undefined && out.keywords === undefined) throw new ToolError('pass name, keywords or both')
  return out
}

const quoteList = (k: string[]): string => (k.length ? k.join(', ') : 'none')

export function describeBrandUpdate(before: Pick<Brand, 'name' | 'keywords'>, patch: BrandPatch): string {
  const parts: string[] = []
  if (patch.name !== undefined && patch.name !== before.name) parts.push(`rename the brand from "${before.name}" to "${patch.name}"`)
  if (patch.keywords !== undefined) parts.push(`set its niche keywords to ${quoteList(patch.keywords)}`)
  return parts.length ? parts.join(' and ') : 'keep the brand as it is'
}

export const BRAND_TOOLS: GatewayTool[] = [
  {
    name: 'brand_update',
    title: 'Update the brand',
    risk: 'edit',
    description:
      "Renames the brand and sets its niche keywords (what trends and searches look for). Pass name, keywords or both. keywords replaces the whole list, so include the current ones you want to keep: up to 30, each up to 60 characters, duplicates are dropped. The name is 1 to 60 characters. The brand's folders on disk stay where they are.",
    inputSchema: obj({
      name: str('The new brand name, e.g. a creator\'s own name for a personal brand', 200, 1),
      keywords: list('Niche keywords or short phrases, the whole list', str('keyword', 200), 100)
    }),
    summarize: (turn, args) => {
      const b = brandOf(turn)
      try {
        const line = describeBrandUpdate(b, cleanBrandUpdate(args))
        return line.charAt(0).toUpperCase() + line.slice(1)
      } catch {
        return `Update the brand ${b.name}`
      }
    },
    run: async (turn, args) => {
      const before = brandOf(turn)
      const patch = cleanBrandUpdate(args)
      const after = await changeBrand(turn.brandId, (b) => {
        if (patch.name !== undefined) b.name = patch.name
        if (patch.keywords !== undefined) b.keywords = patch.keywords
        return { name: b.name, keywords: b.keywords }
      })
      const done: string[] = []
      if (patch.name !== undefined) done.push(after.name === before.name ? `the name was already "${after.name}"` : `renamed the brand from "${before.name}" to "${after.name}"`)
      if (patch.keywords !== undefined) done.push(`niche keywords are now: ${quoteList(after.keywords)}`)
      return `${done.join('. ')}. its brand files and project folders stay where they are`
    }
  }
]
