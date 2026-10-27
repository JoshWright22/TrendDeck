import { useState, type ReactNode } from 'react'
import type { Brand } from '@shared/types'
import type { ThreadSummary } from '@shared/chat'
import { PROJECT_STATUSES, videoProjects, type Project, type ProjectStatus } from '@shared/workspace'
import { Menu } from '../chat/ui'
import { newId } from '../chat/api'
import { usePendingState, waitingThreads } from '../chat/pending'
import { ago, RenameBox, Spinner, STATUS_LABEL } from './Sidebar'

interface Props {
  brand: Brand
  threads: ThreadSummary[]
  editBrand: (fn: (b: Brand) => Brand) => void
  // the newest chat linked to it, or a new chat that gets linked once it's sent
  onOpenProject: (projectId: string) => void
  onNewChatFor: (projectId: string) => void
}

// a plain list of the brand's video projects: where each one is and where its files live.
// the agent makes and moves them from chat, this is for looking and small fixes
export default function VideosList({ brand, threads, editBrand, onOpenProject, onNewChatFor }: Props): ReactNode {
  const [naming, setNaming] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const pend = usePendingState()
  const waiting = waitingThreads(pend, brand.id)
  const projects = [...videoProjects(brand.projects)].sort((a, b) => b.createdAt - a.createdAt)
  const chatsOf = (p: Project): ThreadSummary[] => threads.filter((t) => (brand.chatProjects?.[t.id] ?? []).includes(p.id))

  const edit = (id: string, fn: (p: Project) => Project): void =>
    editBrand((b) => ({ ...b, projects: b.projects.map((p) => (p.id === id ? fn(p) : p)) }))

  const add = (name: string | null): void => {
    setNaming(false)
    if (!name) return
    const p: Project = { id: newId(), name: name.slice(0, 80), createdAt: Date.now(), stageId: brand.pipeline[0]?.id ?? '', status: 'idle', threadIds: [] }
    editBrand((b) => ({ ...b, projects: [...b.projects, p] }))
  }

  // its chats stay, they just aren't linked to it anymore
  const remove = (id: string): void => editBrand((b) => ({ ...b, projects: b.projects.filter((p) => p.id !== id) }))

  const statusOf = (p: Project): ReactNode => {
    const chats = chatsOf(p)
    if (chats.some((t) => waiting.has(t.id))) return <span className="vl-needs-you">Needs you</span>
    if (chats.some((t) => t.busy)) return <span className="vl-working"><Spinner />Agent working</span>
    return STATUS_LABEL[p.status]
  }

  return (
    <section className="vl" aria-label={`${brand.name} videos`}>
      <header className="vl-head">
        <h1>Videos in {brand.name}</h1>
        <span className="spacer" />
        <button className="btn" onClick={() => setNaming(true)}>New video</button>
      </header>
      <p className="vl-note">
        Every chat in {brand.name} can see these. Your agent makes a video project when you start one in chat, and links the chat to it.
      </p>
      {naming && (
        <div className="vl-new">
          <RenameBox value="" label="Video name" onDone={add} />
        </div>
      )}
      {projects.length === 0 && !naming ? (
        <p className="vl-empty">No videos yet. Start a chat and tell your agent what the next video is about.</p>
      ) : (
        <table className="vl-table">
          <thead>
            <tr>
              <th scope="col">Video</th>
              <th scope="col">Stage</th>
              <th scope="col">Status</th>
              <th scope="col">Chats</th>
              <th scope="col">Folder</th>
              <th scope="col"><span className="sr-only">Options</span></th>
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => {
              const chats = chatsOf(p)
              const latest = chats[0]
              return (
                <tr key={p.id}>
                  <td>
                    {renaming === p.id ? (
                      <RenameBox
                        value={p.name}
                        label="Video name"
                        onDone={(v) => {
                          setRenaming(null)
                          if (v) edit(p.id, (x) => ({ ...x, name: v.slice(0, 80) }))
                        }}
                      />
                    ) : (
                      <button className="vl-name" onClick={() => onOpenProject(p.id)} title={latest ? `Open ${latest.title}` : 'Start a chat about it'}>
                        {p.name}
                      </button>
                    )}
                  </td>
                  <td>{brand.pipeline.find((s) => s.id === p.stageId)?.label ?? 'No stage'}</td>
                  <td>{statusOf(p)}</td>
                  <td className="vl-num">{chats.length ? `${chats.length}, latest ${ago(latest.updatedAt)}` : 'None'}</td>
                  <td className="vl-folder" title={p.folder}>{p.folder ?? 'Made when the first file is saved'}</td>
                  <td>
                    <Menu
                      label={`${p.name} options`}
                      className="sb-menu"
                      items={[
                        { label: 'New chat about it', onSelect: () => onNewChatFor(p.id) },
                        { label: 'Rename', onSelect: () => setRenaming(p.id) },
                        ...PROJECT_STATUSES.filter((s): s is ProjectStatus => s !== 'running' && s !== p.status).map((s, i) => ({
                          label: `Mark ${STATUS_LABEL[s].toLowerCase()}`,
                          divider: i === 0,
                          onSelect: () => edit(p.id, (x) => ({ ...x, status: s }))
                        })),
                        { label: 'Delete video project', divider: true, danger: true, onSelect: () => remove(p.id) }
                      ]}
                    />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </section>
  )
}
