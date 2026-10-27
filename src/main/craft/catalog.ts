import type { CraftApp } from '@shared/craft'

// the Craft App Suite (github.com/storytold/craft-launcher, "The Craft App Suite"). each app is
// its own repo whose releases ship a Windows portable zip with <id>.exe and <id>-cli.exe.
// the apps agree on the shape (a loopback control port, an MCP server in the cli) but not on
// the flags, so each one says here how it's started, driven and saved. checked against each
// repo's docs/agents.md and cli source, FilmCraft and PhotoCraft also by hand

// a tool call made with the project file's path put in for '{path}'
export interface ToolStep {
  name: string
  args: Record<string, unknown>
}

export interface CraftSpec extends CraftApp {
  // the file types files() lists. the first is what a new file is saved as
  exts: string[]
  // the window's control token goes in this env var, for the window and for the cli's bridge.
  // null when the app has no token or makes its own
  tokenEnv: string | null
  // the desktop app with its control port
  controlArgs: (port: number) => string[]
  // `<id>-cli mcp` args to drive the open window, null when the app's MCP server can't
  bridgeArgs: ((port: number) => string[]) | null
  // `<id>-cli mcp` args for a headless engine. file is loaded by flag where the app has one,
  // folder confines the agent's file access where the app supports it
  headlessArgs: (file: string | null, folder: string | null) => string[]
  // apps without a file flag load the file with this tool after starting
  openTool: ToolStep | null
  // tool calls that make a new empty file at {path}, run on a headless engine. null: the app
  // opens empty and the user saves into the project folder
  newFile: ToolStep[] | null
  // saves the headless engine's file back, before it's stopped
  save: ToolStep | null
}

const roots = (folder: string | null): string[] => (folder ? ['--automation-read-root', folder, '--automation-write-root', folder] : [])
const PATH = '{path}'
const port = (p: number): string => `127.0.0.1:${p}`
const control = (p: number): string[] => ['--control', String(p)]

export const APPS: CraftSpec[] = [
  {
    id: 'filmcraft',
    name: 'FilmCraft',
    blurb: 'Video editing, color and sound',
    repo: 'storytold/filmcraft',
    agent: true,
    exts: ['.fcproj'],
    tokenEnv: 'FILMCRAFT_CONTROL_TOKEN',
    controlArgs: control,
    bridgeArgs: (p) => ['--bridge', port(p)],
    // no confinement flags, TrendDeck checks every path the agent passes instead
    headlessArgs: (file) => (file ? ['--project', file] : []),
    openTool: null,
    newFile: [{ name: 'command_run', args: { id: 'file.saveAs', params: { path: PATH } } }],
    save: { name: 'command_run', args: { id: 'file.save', params: {} } }
  },
  {
    id: 'photocraft',
    name: 'PhotoCraft',
    blurb: 'Image editing: layers, masks, type and real PSD files',
    repo: 'storytold/photocraft',
    agent: true,
    exts: ['.pcraft', '.psd'],
    tokenEnv: 'PHOTOCRAFT_CONTROL_TOKEN',
    controlArgs: control,
    bridgeArgs: (p) => ['--bridge', port(p)],
    headlessArgs: (_file, folder) => roots(folder),
    openTool: { name: 'doc_open', args: { path: PATH } },
    newFile: [
      { name: 'doc_new', args: {} },
      { name: 'doc_save', args: { path: PATH } }
    ],
    save: { name: 'doc_save', args: { path: PATH } }
  },
  {
    id: 'vectorcraft',
    name: 'VectorCraft',
    blurb: 'Vector illustration',
    repo: 'storytold/vectorcraft',
    agent: true,
    exts: ['.vectorcraft', '.svg', '.ai'],
    tokenEnv: null,
    controlArgs: control,
    bridgeArgs: (p) => ['--connect', port(p)],
    // with no flag it tries a running window first, so headless is always said out loud
    headlessArgs: (_file, folder) => ['--headless', ...roots(folder)],
    openTool: { name: 'open_file', args: { path: PATH } },
    newFile: [{ name: 'save_file', args: { path: PATH } }],
    save: { name: 'save_file', args: { path: PATH } }
  },
  {
    id: 'lightcraft',
    name: 'LightCraft',
    blurb: 'Photo library and raw development',
    repo: 'storytold/lightcraft',
    agent: true,
    // a library, not a document: the project's photos are what it works on
    exts: ['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.heic', '.dng', '.cr2', '.cr3', '.nef', '.arw', '.raf', '.orf', '.rw2'],
    tokenEnv: null,
    controlArgs: control,
    bridgeArgs: (p) => ['--connect', port(p)],
    headlessArgs: (_file, folder) => (folder ? ['--library', `${folder}\\LightCraft Library`] : []),
    openTool: null,
    newFile: null,
    save: null
  },
  {
    id: 'pdfcraft',
    name: 'PdfCraft',
    blurb: 'Reading, organizing and protecting PDFs',
    repo: 'storytold/pdfcraft',
    agent: true,
    exts: ['.pdf'],
    tokenEnv: null,
    // its control channel is a file handshake for its own ui cli, the agent doesn't use it
    controlArgs: () => [],
    bridgeArgs: null,
    headlessArgs: (_file, folder) => roots(folder),
    openTool: { name: 'doc_open', args: { path: PATH } },
    newFile: null,
    save: null
  },
  {
    id: 'effectcraft',
    name: 'EffectCraft',
    blurb: 'Motion graphics and visual effects',
    repo: 'storytold/effectcraft',
    agent: true,
    exts: ['.ecproj'],
    tokenEnv: null,
    controlArgs: control,
    bridgeArgs: (p) => ['--bridge', port(p)],
    headlessArgs: (file, folder) => [...(file ? ['--project', file] : []), ...roots(folder)],
    openTool: null,
    newFile: [
      { name: 'open_project', args: { new: true } },
      { name: 'save_project', args: { path: PATH } }
    ],
    save: { name: 'save_project', args: { path: PATH } }
  },
  {
    id: 'designcraft',
    name: 'DesignCraft',
    blurb: 'Page layout and publishing',
    repo: 'storytold/designcraft',
    agent: true,
    exts: ['.designcraft', '.idml'],
    tokenEnv: null,
    controlArgs: control,
    bridgeArgs: (p) => ['--connect', port(p)],
    headlessArgs: (_file, folder) => roots(folder),
    openTool: { name: 'open_document', args: { path: PATH } },
    newFile: [{ name: 'save_document', args: { path: PATH } }],
    save: { name: 'save_document', args: { path: PATH } }
  },
  {
    id: 'figcraft',
    name: 'FigCraft',
    blurb: 'Interface design and prototyping',
    repo: 'storytold/figcraft',
    agent: true,
    exts: ['.figcraft', '.fig'],
    tokenEnv: null,
    controlArgs: control,
    bridgeArgs: (p) => ['--attach', port(p)],
    headlessArgs: (_file, folder) => roots(folder),
    openTool: { name: 'open_file', args: { path: PATH } },
    newFile: [{ name: 'save_file', args: { path: PATH } }],
    save: { name: 'save_file', args: { path: PATH } }
  },
  {
    id: 'wordcraft',
    name: 'WordCraft',
    blurb: 'Word processing and documents',
    repo: 'storytold/wordcraft',
    agent: true,
    exts: ['.docx', '.odt', '.rtf'],
    // makes its own key file, the bridge finds it
    tokenEnv: null,
    controlArgs: control,
    bridgeArgs: (p) => ['--connect', port(p)],
    headlessArgs: (_file, folder) => roots(folder),
    openTool: { name: 'open_document', args: { path: PATH } },
    newFile: [
      { name: 'new_document', args: { template: 'blank' } },
      { name: 'save_document', args: { path: PATH } }
    ],
    save: { name: 'save_document', args: { path: PATH } }
  },
  {
    id: 'soundcraft',
    name: 'SoundCraft',
    blurb: 'Audio recording and editing',
    repo: 'storytold/soundcraft',
    agent: true,
    exts: ['.scraft'],
    tokenEnv: null,
    controlArgs: control,
    bridgeArgs: (p) => ['--connect', port(p)],
    headlessArgs: (_file, folder) => roots(folder),
    openTool: { name: 'open_session', args: { path: PATH } },
    newFile: [
      { name: 'new_session', args: {} },
      { name: 'save_session', args: { path: PATH } }
    ],
    save: { name: 'save_session', args: { path: PATH } }
  },
  {
    id: 'deckcraft',
    name: 'DeckCraft',
    blurb: 'Presentations and slide decks',
    repo: 'storytold/deckcraft',
    agent: true,
    exts: ['.deckcraft', '.pptx'],
    tokenEnv: null,
    controlArgs: control,
    bridgeArgs: (p) => ['--connect', port(p)],
    headlessArgs: (_file, folder) => roots(folder),
    openTool: { name: 'open_presentation', args: { path: PATH } },
    newFile: [
      { name: 'new_presentation', args: {} },
      { name: 'save_presentation', args: { path: PATH } }
    ],
    save: { name: 'save_presentation', args: { path: PATH } }
  },
  {
    id: 'cadcraft',
    name: 'CADCraft',
    blurb: 'Computer-aided design',
    repo: 'storytold/cadcraft',
    agent: true,
    exts: ['.dxf', '.dwg'],
    // makes its own token file, the bridge reads it
    tokenEnv: null,
    controlArgs: control,
    bridgeArgs: (p) => ['--connect', port(p)],
    headlessArgs: () => [],
    openTool: { name: 'open', args: { path: PATH } },
    newFile: [
      { name: 'new_drawing', args: {} },
      { name: 'save', args: { path: PATH } }
    ],
    save: { name: 'save', args: { path: PATH } }
  },
  {
    id: 'gridcraft',
    name: 'GridCraft',
    blurb: 'Spreadsheets and data',
    repo: 'storytold/gridcraft',
    agent: true,
    exts: ['.xlsx', '.csv'],
    tokenEnv: 'GRIDCRAFT_CONTROL_TOKEN',
    controlArgs: control,
    bridgeArgs: (p) => ['--connect', port(p)],
    headlessArgs: (file) => (file ? ['--in', file] : []),
    openTool: null,
    newFile: [
      { name: 'new_workbook', args: {} },
      { name: 'save_workbook', args: { path: PATH } }
    ],
    save: { name: 'save_workbook', args: { path: PATH } }
  }
]

const byId = new Map(APPS.map((a) => [a.id, a]))

export function spec(id: string): CraftSpec {
  const s = byId.get(id)
  if (!s) throw new Error(`no craft app called ${id}`)
  return s
}

export function isAppId(id: unknown): id is string {
  return typeof id === 'string' && byId.has(id)
}

// a step's args with the file's path put in for {path}
export function fill(step: ToolStep, path: string): ToolStep {
  const put = (v: unknown): unknown =>
    v === PATH ? path : Array.isArray(v) ? v.map(put) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, put(x)])) : v
  return { name: step.name, args: put(step.args) as Record<string, unknown> }
}
