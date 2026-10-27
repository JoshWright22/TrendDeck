import { describe, expect, it } from 'vitest'
import { chatProjectIds, GENERAL_PROJECT_ID, mainProjectId, projectIdForThread, withChatProjects, type Project } from '@shared/workspace'
import { cleanChatProjects, cleanProjects } from './clean'

const pipeline = [
  { id: 'plan', label: 'Plan', kind: 'plan', workspace: 'chat', auto: false, config: {} },
  { id: 'edit', label: 'Edit', kind: 'edit', workspace: 'chat', auto: false, config: {} }
] as never

const project = (id: string, threadIds: string[]): Project => ({ id, name: id, createdAt: 1, stageId: 'plan', status: 'idle', threadIds })

describe('chat project links', () => {
  it('moves old project.threadIds into chat links', () => {
    const old = [project(GENERAL_PROJECT_ID, ['chat-0']), project('ep12', ['chat-1', 'chat-2']), project('ep13', ['chat-3'])]
    const { projects, chatProjects } = cleanChatProjects(undefined, cleanProjects(old, pipeline, 5))
    expect(chatProjects).toEqual({ 'chat-1': ['ep12'], 'chat-2': ['ep12'], 'chat-3': ['ep13'] })
    // chats that were in General stay unlinked
    expect(chatProjects['chat-0']).toBeUndefined()
    expect(projects.find((p) => p.id === GENERAL_PROJECT_ID)?.threadIds).toEqual([])
    expect(projects.find((p) => p.id === 'ep12')?.threadIds).toEqual(['chat-1', 'chat-2'])
  })

  it('keeps links once they exist and rebuilds threadIds from them', () => {
    const projects = cleanProjects([project('ep12', ['stale']), project('ep13', [])], pipeline, 5)
    const out = cleanChatProjects({ 'chat-1': ['ep13', 'ep12', 'ep13', 'gone', GENERAL_PROJECT_ID], 'bad id!': ['ep12'], 'chat-2': [] }, projects)
    expect(out.chatProjects).toEqual({ 'chat-1': ['ep13', 'ep12'] })
    expect(out.projects.find((p) => p.id === 'ep12')?.threadIds).toEqual(['chat-1'])
    expect(out.projects.find((p) => p.id === 'ep13')?.threadIds).toEqual(['chat-1'])
    // the old lookup still finds a project for code that only has the list
    expect(projectIdForThread(out.projects, 'chat-1')).not.toBe(GENERAL_PROJECT_ID)
    const brand = { projects: out.projects, chatProjects: out.chatProjects }
    expect(chatProjectIds(brand, 'chat-1')).toEqual(['ep13', 'ep12'])
    expect(mainProjectId(brand, 'chat-1')).toBe('ep13')
    expect(mainProjectId(brand, 'chat-9')).toBe(GENERAL_PROJECT_ID)
  })

  it('a chat can be linked to several projects at once', () => {
    const projects = cleanProjects([project('ep12', []), project('ep13', [])], pipeline, 5)
    let links = withChatProjects({}, projects, 'chat-1', ['ep12'], 'add')
    links = withChatProjects(links, projects, 'chat-1', ['ep13', GENERAL_PROJECT_ID], 'add')
    expect(links).toEqual({ 'chat-1': ['ep12', 'ep13'] })
    links = withChatProjects(links, projects, 'chat-1', ['ep12'], 'remove')
    expect(links).toEqual({ 'chat-1': ['ep13'] })
    links = withChatProjects(links, projects, 'chat-1', [], 'set')
    expect(links).toEqual({})
  })
})
