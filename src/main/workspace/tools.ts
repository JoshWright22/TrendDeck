import { chatProjectIds, PROJECT_STATUSES, videoProjects } from '@shared/workspace'
import { brandOf } from '../gateway/tools/common'
import { ToolError, type GatewayTool, type Turn } from '../gateway/types'
import { bool, list, obj, oneOf, str } from '../gateway/validate'
import { createProject, editChatProjects } from './index'

// a chat sees the whole brand. these let the agent list the brand's video projects, make one
// and link the chat it's in to the ones it's about

function chatOf(turn: Turn): string {
  if (!turn.threadId) throw new ToolError('this message is not in a saved chat, so it has nothing to link')
  return turn.threadId
}

function projectsOut(turn: Turn): Record<string, unknown> {
  const brand = brandOf(turn)
  const linked = chatProjectIds(brand, turn.threadId)
  return {
    projects: videoProjects(brand.projects).map((p) => ({
      id: p.id,
      name: p.name,
      stage: brand.pipeline.find((s) => s.id === p.stageId)?.label ?? p.stageId,
      status: p.status,
      folder: p.folder ?? null,
      linkedToThisChat: linked.includes(p.id),
      linkedChats: p.threadIds.length
    })),
    thisChatProjects: linked
  }
}

export const WORKSPACE_TOOLS: GatewayTool[] = [
  {
    name: 'project_list',
    title: 'List video projects',
    description:
      "Every video project in the brand with its stage, status and folder, and which ones this chat is linked to. Status is one of " +
      PROJECT_STATUSES.join(', ') +
      '.',
    inputSchema: obj(),
    risk: 'read',
    run: async (turn) => projectsOut(turn)
  },
  {
    name: 'project_create',
    title: 'Make a video project',
    description:
      'Make a new video project in this brand. It starts on the first pipeline stage and gets its own folder the first time a file needs one. It is linked to this chat unless link is false.',
    inputSchema: obj({ name: str('short name the user sees in the sidebar, like "Ep 14"', 80, 1), link: bool('link it to this chat, true when left out') }, ['name']),
    risk: 'edit',
    alwaysAsk: false,
    summarize: (_t, args) => `Make the video project ${String(args.name)}`,
    run: async (turn, args) => {
      brandOf(turn)
      const link = args.link !== false && !!turn.threadId
      const p = await createProject(turn.brandId, String(args.name), link ? turn.threadId : null)
      return { created: { id: p.id, name: p.name }, ...projectsOut(turn) }
    }
  },
  {
    name: 'chat_link_projects',
    title: 'Link this chat to projects',
    description:
      'Link this chat to video projects it is about, unlink it, or replace its links. A chat can be linked to several projects; the first one is where its files and runs go by default.',
    inputSchema: obj(
      {
        project_ids: list('project ids from project_list', str('project id', 64, 1), 50),
        mode: oneOf('add to the links, remove from them, or set them to exactly this list. add when left out', ['add', 'remove', 'set'])
      },
      ['project_ids']
    ),
    risk: 'edit',
    alwaysAsk: false,
    summarize: (turn, args) => {
      const names = (args.project_ids as string[]).map((id) => brandOf(turn).projects.find((p) => p.id === id)?.name ?? id)
      return `${args.mode === 'remove' ? 'Unlink this chat from' : 'Link this chat to'} ${names.join(', ')}`
    },
    run: async (turn, args) => {
      const threadId = chatOf(turn)
      const brand = brandOf(turn)
      const ids = args.project_ids as string[]
      const unknown = ids.filter((id) => !videoProjects(brand.projects).some((p) => p.id === id))
      if (unknown.length) throw new ToolError(`no video project with id ${unknown.join(', ')}, see project_list`)
      await editChatProjects(turn.brandId, threadId, ids, (args.mode as 'add' | 'remove' | 'set' | undefined) ?? 'add')
      return projectsOut(turn)
    }
  }
]
