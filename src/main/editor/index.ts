// the node half of the editor: project files, ffmpeg, and the host that owns open projects.
// the pure model, commands and undo live in @shared/editor

export { setupEditor, editorHost } from './ipc'
export { EditorHost, type EditorHostOptions, type LibraryEntry } from './host'
export {
  ffmpegPaths,
  probe,
  makeProxy,
  waveformPeaks,
  thumbnailStrip,
  renderFrame,
  exportSequence,
  run as runFfmpeg,
  AbortedError,
  FfmpegError,
  type ExportResult,
  type RenderEnv,
  type ProxyOptions
} from './ffmpeg'
export { buildRenderGraph, buildAss, keyframeExpr, EXPORT_PRESETS, type FontResolver, type GraphOptions, type RenderGraph, type OutputSize } from './filtergraph'
export { systemFonts } from './fonts'
export {
  writeAtomic,
  saveProjectFile,
  loadProjectFile,
  listJournals,
  journalPath,
  ProjectAutosaver,
  type AutosaveOptions,
  type JournalEntry,
  type LoadedProject
} from './project-file'
