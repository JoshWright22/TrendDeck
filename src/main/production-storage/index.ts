import { projectIdForThread } from '@shared/workspace'
import { projectFolder } from '../craft/paths'
import { brandOf } from '../gateway/tools/common'
import { ToolError, type GatewayTool, type Turn } from '../gateway/types'
import { list, obj, str } from '../gateway/validate'
import { copyMedia, storageRemotes } from './cloud'
import { commitMetadata, initRepository, repositoryDiff, repositoryStatus, serialize } from './git'
import { noSymlinks, StorageError } from './safety'

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
    description: 'List names and provider types only of user-configured rclone Drive, S3, B2 and OneDrive remotes. No credential/config output or native OAuth. Missing rclone returns setup instructions.',
    inputSchema: obj({ projectId }),
    run: (turn, args) => scoped(turn, args, async (root) => ({ remotes: await storageRemotes(root), note: 'Configure accounts with rclone config outside chat. Native OAuth is not implemented.' }))
  },
  {
    name: 'storage_copy', title: 'Copy selected media to cloud', risk: 'publish', alwaysAsk: true,
    mustAsk: async () => 'Uploading selected brand media to the chosen configured cloud destination requires explicit approval every time.',
    summarize: (_turn, args) => `Copy ${(args.mediaIds as string[]).length} media item(s) to ${String(args.destination)} in brand/project subfolders, without sync or deletion`,
    description: 'Copy up to 100 selected media IDs from this brand with agentAllowed enabled, through an installed user-configured rclone remote. Destination is remote:folder. Creates brand/project/media-ID subfolders; immutable copies never sync, delete or overwrite different existing objects. No credentials or arbitrary local paths accepted.',
    inputSchema: obj({ projectId, mediaIds: list('Permitted media IDs in this brand.', str('Media ID', 100, 1), 100, 1), destination: str('Configured rclone remote:folder/subfolder; no URL or credentials.', 300, 1) }, ['mediaIds', 'destination']),
    run: (turn, args) => scoped(turn, args, (root, project) => copyMedia(root, turn.brandId, project, args.mediaIds as string[], args.destination))
  }
]
