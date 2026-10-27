import { app, ipcMain, webContents, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { EDITOR_CHANNELS as C, type BatchStep, type ExportPresetId } from '@shared/editor'
import { findItem } from '../media/library'
import { systemFonts } from './fonts'
import { EditorHost } from './host'

// wires the editor host to the app window. only the app's own window may call these, never a
// site tab

let host: EditorHost | null = null

export function editorHost(): EditorHost {
  if (!host) {
    host = new EditorHost({
      dataDir: join(app.getPath('userData'), 'editor'),
      fonts: process.platform === 'win32' ? systemFonts() : undefined,
      resolveLibraryItem: async (id) => {
        const m = await findItem(id)
        return m && !m.missing ? { path: m.path, name: m.name, agentAllowed: m.agentAllowed } : null
      }
    })
  }
  return host
}

function str(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v) throw new Error(`${what} is required`)
  return v
}

function handle(channel: string, fn: (...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    if (event.sender.getType() !== 'window') throw new Error('not allowed')
    return fn(...args)
  })
}

function broadcast(channel: string, payload: unknown): void {
  for (const wc of webContents.getAllWebContents()) {
    if (wc.getType() === 'window' && !wc.isDestroyed()) wc.send(channel, payload)
  }
}

export function setupEditor(): void {
  const h = editorHost()
  h.onChange((e) => broadcast(C.changed, e))
  h.onExportProgress((e) => broadcast(C.exportProgress, e))

  handle(C.list, () => h.list())
  handle(C.create, (name) => h.create(typeof name === 'string' ? name : undefined))
  handle(C.open, (path) => h.open(str(path, 'file path')))
  handle(C.close, (id, opts) => h.close(str(id, 'project id'), (opts ?? {}) as { discard?: boolean }))
  handle(C.save, (id, path) => h.save(str(id, 'project id'), typeof path === 'string' ? path : undefined))
  handle(C.snapshot, (id) => h.snapshot(str(id, 'project id')))
  handle(C.execute, (id, cmd, args) => h.execute(str(id, 'project id'), str(cmd, 'command id'), args))
  handle(C.batch, (id, steps, opts) => h.batch(str(id, 'project id'), steps as BatchStep[], (opts ?? {}) as { label?: string; stopOnError?: boolean }))
  handle(C.undo, (id) => h.undo(str(id, 'project id')))
  handle(C.redo, (id) => h.redo(str(id, 'project id')))
  handle(C.checkpoint, (id, label) => h.checkpoint(str(id, 'project id'), str(label, 'label')))
  handle(C.revert, (id, cp) => h.revert(str(id, 'project id'), str(cp, 'checkpoint id')))
  handle(C.importMedia, (id, paths, binId) =>
    h.importMedia(str(id, 'project id'), Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : [], typeof binId === 'string' ? binId : undefined)
  )
  handle(C.renderFrame, async (id, seqId, tick, opts) =>
    new Uint8Array(await h.renderFrame(str(id, 'project id'), str(seqId, 'sequence id'), Number(tick) || 0, (opts ?? {}) as { maxWidth?: number }))
  )
  handle(C.waveform, (id, mediaId) => h.waveform(str(id, 'project id'), str(mediaId, 'media id')))
  handle(C.thumbnails, (id, mediaId, count, height) => h.thumbnails(str(id, 'project id'), str(mediaId, 'media id'), Number(count) || 10, typeof height === 'number' ? height : undefined))
  handle(C.makeProxy, (id, mediaId) => h.makeProxy(str(id, 'project id'), str(mediaId, 'media id')))
  handle(C.exportStart, (id, seqId, preset, out) => h.exportStart(str(id, 'project id'), str(seqId, 'sequence id'), str(preset, 'preset') as ExportPresetId, str(out, 'output path')))
  handle(C.exportCancel, (jobId) => h.exportCancel(str(jobId, 'job id')))
  handle(C.recoverable, () => h.recoverable())
  handle(C.recover, (id) => h.recover(str(id, 'project id')))

  app.on('before-quit', () => void h.shutdown())
}
