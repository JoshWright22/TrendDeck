import { join } from 'node:path'

// where projects go by default: Documents\TrendDeck, unless OneDrive has taken Documents over.
// raw footage there gets uploaded, fills the free plan, and turns into online-only files that
// stall the editors, so then it's Videos\TrendDeck, or the home folder if OneDrive has that too

export function inOneDrive(path: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const p = path.toLowerCase()
  const roots = [env.OneDrive, env.OneDriveConsumer, env.OneDriveCommercial].filter((r): r is string => !!r).map((r) => r.toLowerCase().replace(/[\\/]+$/, ''))
  return roots.some((r) => p === r || p.startsWith(`${r}\\`) || p.startsWith(`${r}/`)) || /[\\/]onedrive( - [^\\/]+)?([\\/]|$)/i.test(path)
}

export function defaultRoot(dirs: { documents: string; videos: string; home: string }, env: NodeJS.ProcessEnv = process.env): string {
  for (const d of [dirs.documents, dirs.videos, dirs.home]) if (d && !inOneDrive(d, env)) return join(d, 'TrendDeck')
  return join(dirs.home, 'TrendDeck')
}

// every way a saved file spells a folder: as is, with forward slashes, and inside JSON where each
// backslash is doubled. longest first so the escaped form isn't half replaced
export function swapRoot(text: string, from: string, to: string): string {
  const forms = (p: string): string[] => [p.replace(/\\/g, '\\\\'), p, p.replace(/\\/g, '/')]
  const a = forms(from)
  const b = forms(to)
  let out = text
  for (let i = 0; i < a.length; i++) out = out.split(a[i]).join(b[i])
  return out
}
