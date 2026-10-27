import { projectIdForThread } from '@shared/workspace'
import { projectFolder } from '../craft/paths'
import { brandOf } from '../gateway/tools/common'
import { ToolError, type GatewayTool, type Turn } from '../gateway/types'
import { list, obj, str } from '../gateway/validate'
import type { HistoryCard, StorageCard } from '@shared/cards'
import { addCard, changeCard, newCardId } from '../cards/store'
import { copyMedia, storageRemotes } from './cloud'
import { commitMetadata, hasRepository, initRepository, repositoryDiff, repositoryHistory, repositoryStatus, serialize } from './git'
import { remoteKind, REMOTE_NAMES } from './remotes'
import { noSymlinks, StorageError } from './safety'
import { remoteLabels, storageSettings } from './settings'

export { setupStorageSettings, dropStorageBrand } from './settings'

// a history card for the chat: the project's checkpoints and what changed since the last one
export async function historyCard(base: Pick<HistoryCard, 'brandId' | 'threadId' | 'messageId'>, projectId: string, root: string): Promise<HistoryCard> {
  const now = Date.now()
  // a project with no history yet still gets a card, saving the first checkpoint starts one
  const { entries, changed } = (await hasRepository(root)) ? await repositoryHistory(root, 20) : { entries: [], changed: [] }
  return {
    ...base,
    id: newCardId(),
    at: now,
    updatedAt: now,
    type: 'history',
    projectId,
    entries,
    changed,
    note: entries.length ? '' : 'No checkpoints yet.'
  }
}

const projectId = str("Project ID in this brand; defaults to this thread's project.", 100, 1)
const fileList = list('Explicit project-relative text metadata files; never media or credentials.', str('Metadata path', 240, 1), 50, 1)

async function scoped<T>(turn: Turn, args: Record<string, unknown>, action: (root: string, project: string) => Promise<T>): Promise<T> {
  try {
    const brand = brandOf(turn)
    const id = typeof args.projectId === 'string' ? args.projectId : projectIdForThread(brand.projects, turn.threadId ?? '')
    if (!brand.projects.some((project) => project.id === id)) throw new ToolError('No such project in this brand.')
    const root = await noSymlinks(await projectFolder(turn.brandId, id))
    return await serialize(root, () => action(root, id))
  } catch (error) {
    if (error instanceof StorageError || error instanceof ToolError) throw new ToolError(error.message)
    throw new ToolError('Storage operation could not complete. Check the project and permitted media outside chat; private paths and diagnostics are withheld.')
  }
}

export const STORAGE_TOOLS: GatewayTool[] = [
  {
    name: 'git_status', title: 'Project Git status', risk: 'read',
    description: 'Show tracked metadata changes in this brand project. Does not list recordings, secrets, remote URLs or untracked files. Requires a repository created by git_init.',
    inputSchema: obj({ projectId }),
    run: (turn, args) => scoped(turn, args, repositoryStatus)
  },
  {
    name: 'git_init', title: 'Initialize project Git', risk: 'edit', alwaysAsk: true,
    mustAsk: async () => 'Creating local Git metadata and the metadata-only ignore policy requires explicit approval.',
    description: 'Create an isolated metadata-only Git repository in this brand project, with media/credential ignores before any staging. Leaves existing/custom repositories and ignore files untouched. Does not stage, commit or push.',
    inputSchema: obj({ projectId }),
    run: (turn, args) => scoped(turn, args, initRepository)
  },
  {
    name: 'git_diff', title: 'Project metadata diff', risk: 'read',
    description: 'Read bounded staged and working diffs of tracked text metadata only. Possible secrets cause refusal, not disclosure. Omit files for all tracked metadata.',
    inputSchema: obj({ projectId, files: fileList }),
    run: (turn, args) => scoped(turn, args, (root) => repositoryDiff(root, (args.files as string[] | undefined) ?? []))
  },
  {
    name: 'git_commit', title: 'Commit project metadata', risk: 'edit', alwaysAsk: true,
    mustAsk: async () => 'Committing the selected text metadata requires explicit approval every time. No recordings or credentials are allowed.',
    summarize: (_turn, args) => `Commit ${(args.files as string[]).length} selected metadata file(s) and the ignore policy; do not push`,
    description: 'Commit explicit, small UTF-8 metadata snapshots plus the mandatory ignore policy using local TrendDeck author identity. Rejects existing staged changes, binary/media files, links and likely secrets. No arbitrary commands, remotes or pushes.',
    inputSchema: obj({ projectId, files: fileList, message: str('Short commit message without secrets.', 500, 1) }, ['files', 'message']),
    run: (turn, args) => scoped(turn, args, (root) => commitMetadata(root, args.files as string[], args.message as string))
  },
  {
    name: 'git_push', title: 'Project Git push setup', risk: 'publish', alwaysAsk: true,
    mustAsk: async () => 'Git pushes require explicit approval and a mandatory redacted Gitleaks scan; publishing is currently disabled.',
    description: 'Disabled, fail-closed placeholder: no project push is performed until mandatory redacted Gitleaks scanning and safe user-configured remote handling are integrated. Never bypasses push hooks or force-pushes.',
    inputSchema: obj({ projectId }),
    run: (turn, args) => scoped(turn, args, async () => {
      throw new StorageError('Setup needed: project Git push is disabled. Integrate a mandatory, redacted, fail-closed Gitleaks scan and safe user-configured remotes before enabling pushes. Do not bypass hooks. No files were pushed.')
    })
  },
  {
    name: 'storage_remotes', title: 'Available cloud storage', risk: 'read',
    description: "List names and kinds only of the user's cloud remotes (Google Drive, Dropbox, OneDrive, Amazon S3, Cloudflare R2, Backblaze B2, through rclone), and this brand's default destination and what happens to originals after a checked copy. No credentials or config output. Missing rclone returns setup instructions.",
    inputSchema: obj({ projectId }),
    run: (turn, args) => scoped(turn, args, async (root) => {
      const settings = await storageSettings(turn.brandId)
      const labels = await remoteLabels()
      const remotes = (await storageRemotes(root)).map((r) => {
        const kind = remoteKind(r, labels)
        return { name: r.name, kind: kind ? REMOTE_NAMES[kind] : r.provider }
      })
      return {
        remotes,
        defaultDestination: settings.defaultDestination || null,
        afterCopy: settings.afterCopy === 'archive' ? 'originals go to the Recycle Bin after the cloud copy checks out' : 'originals stay on this computer',
        note: 'The user sets up remotes in Settings, Storage. Never ask for keys or passwords in chat.'
      }
    })
  },
  {
    name: 'storage_copy', title: 'Copy selected media to cloud', risk: 'publish', alwaysAsk: true,
    mustAsk: async (turn) => (await storageSettings(turn.brandId)).afterCopy === 'archive'
      ? 'Uploading selected brand media to the cloud needs your OK every time. This brand moves originals to the Recycle Bin after the cloud copy checks out.'
      : 'Uploading selected brand media to the chosen configured cloud destination requires explicit approval every time.',
    summarize: async (turn, args) => `Copy ${(args.mediaIds as string[]).length} media item(s) to ${String(args.destination ?? ((await storageSettings(turn.brandId)).defaultDestination || 'the default destination'))} in brand/project subfolders, without sync or deletion`,
    description: "Copy up to 100 selected media IDs from this brand with agentAllowed enabled, through one of the user's rclone remotes. Destination is remote:folder; leave it out for the brand's default. Creates brand/project/media-ID subfolders; immutable copies never sync, delete or overwrite different existing objects. Each copy is checked against the cloud; when the brand is set to archive, a checked original goes to the Recycle Bin. A storage card in the chat shows progress. No credentials or arbitrary local paths accepted.",
    inputSchema: obj({ projectId, mediaIds: list('Permitted media IDs in this brand.', str('Media ID', 100, 1), 100, 1), destination: str('Configured rclone remote:folder/subfolder; no URL or credentials. Leave out for the default.', 300, 1) }, ['mediaIds']),
    run: (turn, args) => scoped(turn, args, async (root, project) => {
      const settings = await storageSettings(turn.brandId)
      const destination = typeof args.destination === 'string' ? args.destination : settings.defaultDestination
      if (!destination) throw new StorageError('No destination. Pass one, or ask the user to pick a default in Settings, Storage.')
      const ids = [...new Set(args.mediaIds as string[])]
      const now = Date.now()
      const card: StorageCard = {
        id: newCardId(), brandId: turn.brandId, threadId: turn.threadId, messageId: turn.messageId ?? null, at: now, updatedAt: now,
        type: 'storage', destination, total: ids.length, copied: 0, verified: 0, archived: 0, status: 'running', note: ''
      }
      await addCard(card)
      try {
        const out = await copyMedia(root, turn.brandId, project, ids, destination, {
          archive: settings.afterCopy === 'archive',
          onProgress: (p) => void changeCard(turn.brandId, card.id, (c) => { if (c.type === 'storage') Object.assign(c, p) })
        })
        await changeCard(turn.brandId, card.id, (c) => {
          if (c.type !== 'storage') return
          Object.assign(c, { copied: out.copied.length, verified: out.verified.length, archived: out.archived.length, status: out.ok ? 'done' : 'failed', note: out.note })
        })
        return { ...out, card: card.id }
      } catch (error) {
        await changeCard(turn.brandId, card.id, (c) => { if (c.type === 'storage') Object.assign(c, { status: 'failed', note: error instanceof StorageError ? error.message : 'The copy could not start.' }) })
        throw error
      }
    })
  },
  {
    name: 'git_history', title: 'Show project history', risk: 'read',
    description: "Shows the project's checkpoints (git commits of its scripts, captions and notes; never media) as a history card in the chat, where the user can see what changed and restore a checkpoint. Also returns them to you.",
    inputSchema: obj({ projectId }),
    run: (turn, args) => scoped(turn, args, async (root, project) => {
      const card = await historyCard({ brandId: turn.brandId, threadId: turn.threadId, messageId: turn.messageId ?? null }, project, root)
      await addCard(card)
      return { card: card.id, checkpoints: card.entries.map((e) => ({ commit: e.commit.slice(0, 12), message: e.message, at: new Date(e.at).toISOString(), files: e.files })), changedSinceLast: card.changed }
    })
  }
]
