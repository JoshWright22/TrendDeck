import { nativeImage } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { VisualsCard } from '@shared/cards'
import {
  LICENSE_FILTERS,
  ORIENTATIONS,
  PROVIDER_NAMES,
  PROVIDERS,
  VISUAL_KINDS,
  creditLine,
  resultSize,
  type VisualSearchInput
} from '@shared/visuals'
import { projectFolder } from '../craft/paths'
import { addCard, newCardId } from '../cards/store'
import { projectOf } from '../cards/tools'
import { clip } from '../gateway/tools/common'
import { ContentResult, ToolError, type GatewayTool } from '../gateway/types'
import { int, list, obj, oneOf, str } from '../gateway/validate'
import { keyFor } from './keys'
import { VisualNetError } from './net'
import { resultsText, searchVisuals } from './search'
import { assetPath, cachedThumb, creditsText, findResult, ID, readAsset, readCredits, VisualError } from './store'

// the agent's side of visuals: find options online (a grid the user picks from), look at one,
// put one in the video files with its credit, and list the credits for the description

export interface ToolDeps {
  root: () => string
  // downloads a search option or copies an asset into the project, see index.ts
  toProject: (brandId: string, projectId: string, id: string, threadId: string | null, byAgent: boolean) => Promise<{ file: string; credit: string; note: string }>
}

const RESULT_ID = /^(openverse|wikimedia|pexels|pixabay):[A-Za-z0-9._-]{1,100}$/

// an image small enough for the agent: at most 1600 px on the long side, png or jpeg
function forAgent(bytes: Buffer, mime: string): { data: string; mimeType: string } {
  const img = nativeImage.createFromBuffer(bytes)
  if (img.isEmpty()) {
    if (mime === 'image/png' || mime === 'image/jpeg') return { data: bytes.toString('base64'), mimeType: mime }
    throw new ToolError("that image can't be shown")
  }
  const { width, height } = img.getSize()
  const scale = Math.min(1, 1600 / Math.max(width, height))
  const small = scale < 1 ? img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'good' }) : img
  if (mime === 'image/png' && scale === 1 && bytes.length < 4_000_000) return { data: bytes.toString('base64'), mimeType: 'image/png' }
  return { data: small.toJPEG(85).toString('base64'), mimeType: 'image/jpeg' }
}

const fail = (err: unknown): never => {
  if (err instanceof VisualError || err instanceof VisualNetError) throw new ToolError(err.message)
  throw err
}

export function visualTools(d: ToolDeps): GatewayTool[] {
  return [
    {
      name: 'find_visuals',
      title: 'Find visuals online',
      description:
        "Searches free stock and open-license sources (Openverse and Wikimedia Commons without a key; Pexels and Pixabay when the user saved a free key) and shows the options in the chat as a grid. The user picks from it: send one to you, add it to the video files, insert it at the FilmCraft playhead or open it in PhotoCraft. Use it when a video needs b-roll, a reference image, a GIF, music or a sound, or when the user asks for options to choose from. Results come with license, author and source; prefer license commercial for monetized videos and say when credit is needed. Show a few good options instead of describing images in words.",
      inputSchema: obj(
        {
          query: str('what to look for, a few plain words, e.g. "city timelapse night"', 120, 1),
          kind: oneOf('image, video, gif or audio', VISUAL_KINDS),
          orientation: oneOf('landscape for 16:9 videos, portrait for Shorts and Reels', ORIENTATIONS),
          license: oneOf('any-free, commercial (fine for monetized videos) or no-attribution (no credit needed)', LICENSE_FILTERS),
          count: int('how many options, 1 to 24, default 12', 1, 24),
          providers: list('only these sources, all that can search the kind when left out', oneOf('source', PROVIDERS), 4),
          note: str('one line for the user above the grid, e.g. what the options are for', 300)
        },
        ['query', 'kind']
      ),
      risk: 'read',
      annotations: { openWorldHint: true },
      summarize: (_turn, args) => `Find ${String(args.kind)}s: ${clip(String(args.query), 80)}`,
      run: async (turn, args) => {
        const search = await searchVisuals(d.root(), turn.brandId, args as unknown as VisualSearchInput, keyFor).catch(fail)
        const now = Date.now()
        const card: VisualsCard = {
          id: newCardId(),
          brandId: turn.brandId,
          threadId: turn.threadId,
          messageId: turn.messageId ?? null,
          at: now,
          updatedAt: now,
          type: 'visuals',
          search,
          note: typeof args.note === 'string' ? args.note.trim() : ''
        }
        await addCard(card)
        if (!search.results.length) {
          const why = search.providers.filter((p) => p.state !== 'ok').map((p) => `${PROVIDER_NAMES[p.provider]}: ${p.note}`)
          return `nothing found for "${search.input.query}". try fewer or plainer words, another kind or a looser license.${why.length ? `\n${why.join('\n')}` : ''}`
        }
        return resultsText(search)
      }
    },
    {
      name: 'visual_get',
      title: 'Look at a visual',
      description:
        "Shows you a visual: a sketch, screenshot or image the user attached (visual id from their message), or an option from find_visuals (its id, like openverse:abc or pexels:123, you get its preview). Comes with where it's from and its license.",
      inputSchema: obj({ id: str('the visual id or the option id', 120, 1) }, ['id']),
      risk: 'read',
      run: async (turn, args) => {
        const id = String(args.id).trim()
        if (RESULT_ID.test(id)) {
          const r = await findResult(d.root(), turn.brandId, id)
          if (!r) throw new ToolError(`no option ${id} in a recent search of this brand. search again with find_visuals`)
          const meta = `${r.title} by ${r.author || 'unknown'}, ${PROVIDER_NAMES[r.provider]}, ${r.license.name}${r.license.attribution ? ', credit needed' : ''}${r.license.commercial ? '' : ', not for commercial use'}. ${resultSize(r)}. source ${r.pageUrl}`
          const thumb = r.thumb || (r.thumbUrl ? await cachedThumb(d.root(), turn.brandId, r.thumbUrl) : null)
          if (!thumb) return new ContentResult([{ type: 'text', text: `${meta}\n(no preview for this one${r.kind === 'audio' ? ', it is audio' : ''})` }])
          const bytes = await fs.readFile(join(d.root(), turn.brandId, ...thumb.split('/')))
          return new ContentResult([{ type: 'image', ...forAgent(bytes, '') }, { type: 'text', text: `preview of ${meta}` }])
        }
        if (!ID.test(id)) throw new ToolError('that id is not valid')
        const a = await readAsset(d.root(), turn.brandId, id)
        if (!a) throw new ToolError(`no visual ${id} for this brand`)
        const bytes = await fs.readFile(assetPath(d.root(), a)).catch(() => fail(new VisualError('that visual file is gone')))
        const from = a.source
          ? `from ${PROVIDER_NAMES[a.source.provider]} (${a.source.license.name}, by ${a.source.author || 'unknown'}, ${a.source.pageUrl})`
          : a.origin === 'sketch'
            ? 'drawn by the user in TrendDeck'
            : a.origin === 'link'
              ? `from ${a.sourceUrl}, license unknown, ask before using it in the video`
              : a.origin === 'frame'
                ? 'a frame from the editor the user drew on'
                : 'pasted by the user'
        const text = `${a.name}, ${a.width} by ${a.height}, ${from}.${a.note ? ` The user's note: ${a.note}` : ''}`
        return new ContentResult([{ type: 'image', ...forAgent(bytes, a.mime) }, { type: 'text', text }])
      }
    },
    {
      name: 'visual_save',
      title: 'Add a visual to the video files',
      description:
        "Downloads an option from find_visuals (or copies a visual the user attached) into the project's media/visuals folder, with a .credit.json next to it that keeps the source, author, license and date. Returns the file path to use with the Craft tools (e.g. import it in FilmCraft) and the credit line. Add only what the user picked or clearly asked for.",
      inputSchema: obj(
        {
          id: str('the option id (e.g. pexels:123) or visual id', 120, 1),
          projectId: str("the TrendDeck project (one video), by id. leave it out for this chat's project", 100)
        },
        ['id']
      ),
      risk: 'edit',
      annotations: { openWorldHint: true },
      summarize: (_turn, args) => `Add ${clip(String(args.id), 80)} to the video files`,
      run: async (turn, args) => {
        const project = projectOf(turn, args.projectId)
        const out = await d.toProject(turn.brandId, project.id, String(args.id).trim(), turn.threadId, true).catch(fail)
        return `${out.note} file: ${out.file}${out.credit ? `\ncredit: ${out.credit}` : ''}`
      }
    },
    {
      name: 'visual_credits',
      title: 'List the credits for found visuals',
      description:
        "Lists every downloaded visual in the project folder with where it came from, its author and license, read from the .credit.json files, plus a ready credits block for the video description. Use it before writing the description of a video that uses found images, clips, GIFs or music.",
      inputSchema: obj({ projectId: str("the TrendDeck project (one video), by id. leave it out for this chat's project", 100) }),
      risk: 'read',
      run: async (turn, args) => {
        const project = projectOf(turn, args.projectId)
        const list = await readCredits(await projectFolder(turn.brandId, project.id))
        if (!list.length) return `no found visuals in ${project.name} yet`
        const items = list.map((p) => ({
          file: p.file,
          origin: p.origin,
          source: p.provider ? PROVIDER_NAMES[p.provider] : p.sourceUrl || 'TrendDeck',
          title: p.title,
          author: p.author,
          license: p.license?.name ?? (p.origin === 'link' ? 'unknown, check the source' : 'yours'),
          creditNeeded: p.license?.attribution ?? p.origin === 'link',
          commercial: p.license?.commercial ?? null,
          sourceUrl: p.sourceUrl,
          retrievedAt: p.retrievedAt,
          credit: creditLine(p)
        }))
        return { project: project.name, items, description: creditsText(list) }
      }
    }
  ]
}
