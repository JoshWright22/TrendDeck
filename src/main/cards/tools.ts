import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { SUGGESTION_KINDS, SUGGESTION_NAMES, type EditState, type SuggestionCard, type SuggestionKind, type VideoCard } from '@shared/cards'
import { projectIdForThread, type Project } from '@shared/workspace'
import { brandOf, clip } from '../gateway/tools/common'
import { ImageResult, ToolError, type GatewayTool, type Turn } from '../gateway/types'
import { list, num, obj, oneOf, str } from '../gateway/validate'
import { checkProjectFile, FileRefError } from './files'
import { addCard, cardsDir, changeCard, getCard, newCardId } from './store'

// show_video and suggest put cards in the chat, card_update moves an edit suggestion along,
// review_frame_get shows the agent a frame the user commented on. all read risk: they only show
// things, anything that changes the project still goes through the editors' own tools

const PROJECT_ARG = str("the TrendDeck project (one video), by id. leave it out for this chat's project", 100)

export function projectOf(turn: Turn, projectId: unknown): Project {
  const brand = brandOf(turn)
  const id = typeof projectId === 'string' && projectId ? projectId : projectIdForThread(brand.projects, turn.threadId ?? '')
  const p = brand.projects.find((x) => x.id === id)
  if (!p) throw new ToolError(`no project ${id} in this brand. projects: ${brand.projects.map((x) => `${x.id} (${x.name})`).join(', ')}`)
  return p
}

async function fileRef(turn: Turn, projectId: string, file: string) {
  try {
    return await checkProjectFile(turn.brandId, projectId, file)
  } catch (err) {
    if (err instanceof FileRefError) throw new ToolError(err.message)
    throw err
  }
}

function range(args: Record<string, unknown>, a = 'from', b = 'to'): { from: number | null; to: number | null } {
  const from = typeof args[a] === 'number' ? (args[a] as number) : null
  let to = typeof args[b] === 'number' ? (args[b] as number) : null
  if (from !== null && to !== null && to < from) throw new ToolError(`${b} is before ${a}`)
  if (to !== null && from === null) to = null
  return { from, to }
}

const base = (turn: Turn) => {
  const now = Date.now()
  return { id: newCardId(), brandId: turn.brandId, threadId: turn.threadId, messageId: turn.messageId ?? null, at: now, updatedAt: now }
}

const EDIT_STATES: EditState[] = ['previewing', 'applied', 'failed', 'undone']

export function cardTools(): GatewayTool[] {
  return [
    {
      name: 'show_video',
      title: 'Show a video in the chat',
      description:
        "Shows a video, image or audio file from the project folder as a card in the chat, so the user can play it, scrub, loop a part, highlight a time range, draw a box on a paused frame and leave timestamped comments. Their comments come back to you as a message with the file, the time ranges and frame ids (see review_frame_get). Use it to show progress: a render, an export, a take. from and to (seconds) point at the part you want them to look at. file is relative to the project folder.",
      inputSchema: obj(
        {
          projectId: PROJECT_ARG,
          file: str('a video, image or audio file in the project folder, e.g. exports/cut-v2.mp4', 260, 1),
          from: num('seconds, where the part to look at starts', 0),
          to: num('seconds, where it ends', 0),
          note: str('one or two lines on what to look at', 500),
          title: str('short card title, the file name when left out', 120)
        },
        ['file']
      ),
      risk: 'read',
      run: async (turn, args) => {
        const project = projectOf(turn, args.projectId)
        const { ref } = await fileRef(turn, project.id, String(args.file))
        const card: VideoCard = {
          ...base(turn),
          type: 'video',
          title: typeof args.title === 'string' && args.title.trim() ? args.title.trim() : ref.file.split('/').pop()!,
          media: ref,
          ...range(args),
          note: typeof args.note === 'string' ? args.note.trim() : '',
          auto: false
        }
        await addCard(card)
        return `showing ${ref.file} in the chat as card ${card.id}. the user can play it and send timestamped comments, those come back as a message`
      }
    },
    {
      name: 'suggest',
      title: 'Suggest something for the video',
      description:
        "Puts a suggestion card in the chat: an edit, a shot to get, a title, a thumbnail idea, a caption or anything else. The user picks Accept, Not now, one of your actions, or replies; that comes back to you as a message, so you don't need to wait. preview is a video or image file in the project folder to show with it (a render of the proposed edit, a thumbnail draft). For kind edit the card also offers Preview, Apply and Undo: on Apply TrendDeck first saves a checkpoint of the project's editor files, then asks you to apply it; report how it went with card_update. Use this for ideas instead of long lists in your reply.",
      inputSchema: obj(
        {
          title: str('short, what you suggest', 120, 1),
          body: str('why and what exactly, a few lines', 2000, 1),
          kind: oneOf('what it is about', SUGGESTION_KINDS),
          projectId: PROJECT_ARG,
          preview: str('optional video or image file in the project folder to show with it', 260),
          previewFrom: num('seconds, where the preview part starts', 0),
          previewTo: num('seconds, where it ends', 0),
          actions: list('up to 3 extra choices, short labels like "Use version B"', str('label', 40, 1), 3)
        },
        ['title', 'body', 'kind']
      ),
      risk: 'read',
      summarize: (_turn, args) => `Suggest: ${clip(String(args.title), 100)}`,
      run: async (turn, args) => {
        const kind = args.kind as SuggestionKind
        let preview: SuggestionCard['preview'] = null
        if (typeof args.preview === 'string' && args.preview.trim()) {
          const project = projectOf(turn, args.projectId)
          const { ref } = await fileRef(turn, project.id, args.preview)
          preview = { ...ref, ...range(args, 'previewFrom', 'previewTo') }
        }
        const actions = [...new Set(((args.actions as string[] | undefined) ?? []).map((a) => a.trim()).filter(Boolean))]
          .filter((a) => !/^(accept|not now|reply)$/i.test(a))
          .slice(0, 3)
        const card: SuggestionCard = {
          ...base(turn),
          type: 'suggestion',
          kind,
          title: String(args.title).trim(),
          body: String(args.body).trim(),
          preview,
          actions,
          answer: null,
          edit: kind === 'edit' ? { state: 'proposed', note: '', checkpoint: null } : null
        }
        await addCard(card)
        return `shown as ${SUGGESTION_NAMES[kind].toLowerCase()} suggestion card ${card.id}. the user's answer comes back as a message, keep working or end your reply`
      }
    },
    {
      name: 'card_update',
      title: 'Update an edit suggestion card',
      description:
        "Says on an edit suggestion card what happened: previewing (you rendered a preview, pass it as preview), applied, failed (say why in note) or undone. Only say applied or undone after the editor's tool result confirmed it.",
      inputSchema: obj(
        {
          cardId: str('the card id from suggest', 100, 1),
          state: oneOf('what happened', EDIT_STATES),
          note: str('one line for the user', 300),
          preview: str('a render of the proposal in the project folder', 260)
        },
        ['cardId', 'state']
      ),
      risk: 'read',
      run: async (turn, args) => {
        const card = await getCard(turn.brandId, String(args.cardId))
        if (!card || card.type !== 'suggestion' || card.threadId !== turn.threadId) throw new ToolError(`no suggestion card ${String(args.cardId)} in this chat`)
        if (!card.edit) throw new ToolError(`card ${card.id} isn't an edit suggestion`)
        let preview = card.preview
        if (typeof args.preview === 'string' && args.preview.trim()) {
          const { ref } = await fileRef(turn, card.preview?.projectId ?? projectOf(turn, undefined).id, args.preview)
          preview = { ...ref, from: null, to: null }
        }
        await changeCard(turn.brandId, card.id, (c) => {
          if (c.type !== 'suggestion' || !c.edit) return
          c.edit.state = args.state as EditState
          c.edit.note = typeof args.note === 'string' ? args.note.trim() : ''
          c.preview = preview
        })
        return `card ${card.id} now says ${String(args.state)}`
      }
    },
    {
      name: 'review_frame_get',
      title: 'See a frame the user commented on',
      description:
        'The still frame the user captured while reviewing a video, with the box they drew outlined on it. Frame ids come in their review comments.',
      inputSchema: obj({ frameId: str('the frame id from the review comment', 64, 1) }, ['frameId']),
      risk: 'read',
      run: async (turn, args) => {
        const id = String(args.frameId)
        if (!/^[a-z0-9-]{1,64}$/i.test(id)) throw new ToolError('that frame id is not valid')
        const dir = join(cardsDir(), 'frames', turn.brandId)
        try {
          const png = await fs.readFile(join(dir, `${id}.png`))
          const meta = JSON.parse(await fs.readFile(join(dir, `${id}.json`), 'utf8')) as { timeSeconds?: number; box?: unknown; width?: number; height?: number }
          const box = meta.box as { x: number; y: number; width: number; height: number } | null
          const note = `frame at ${Number(meta.timeSeconds ?? 0).toFixed(3)} s, ${meta.width} by ${meta.height}${box ? `, the user's box is outlined at x ${box.x}, y ${box.y}, ${box.width} by ${box.height}` : ''}`
          return new ImageResult(png, note)
        } catch {
          throw new ToolError(`no frame ${id} for this brand`)
        }
      }
    }
  ]
}
