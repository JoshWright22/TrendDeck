import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { FontResolver } from './filtergraph'

// font files for drawtext and a folder for libass. windows only for now: the system fonts
// folder plus per-user installs, falling back to Arial when a family isn't there

const FAMILIES: Record<string, [regular: string, bold: string, italic: string, boldItalic: string]> = {
  arial: ['arial.ttf', 'arialbd.ttf', 'ariali.ttf', 'arialbi.ttf'],
  'segoe ui': ['segoeui.ttf', 'segoeuib.ttf', 'segoeuii.ttf', 'segoeuiz.ttf'],
  verdana: ['verdana.ttf', 'verdanab.ttf', 'verdanai.ttf', 'verdanaz.ttf'],
  tahoma: ['tahoma.ttf', 'tahomabd.ttf', 'tahoma.ttf', 'tahomabd.ttf'],
  'times new roman': ['times.ttf', 'timesbd.ttf', 'timesi.ttf', 'timesbi.ttf'],
  georgia: ['georgia.ttf', 'georgiab.ttf', 'georgiai.ttf', 'georgiaz.ttf'],
  impact: ['impact.ttf', 'impact.ttf', 'impact.ttf', 'impact.ttf'],
  'comic sans ms': ['comic.ttf', 'comicbd.ttf', 'comici.ttf', 'comicz.ttf'],
  'courier new': ['cour.ttf', 'courbd.ttf', 'couri.ttf', 'courbi.ttf'],
  consolas: ['consola.ttf', 'consolab.ttf', 'consolai.ttf', 'consolaz.ttf'],
  'trebuchet ms': ['trebuc.ttf', 'trebucbd.ttf', 'trebucit.ttf', 'trebucbi.ttf'],
  inter: ['Inter-Regular.ttf', 'Inter-Bold.ttf', 'Inter-Italic.ttf', 'Inter-BoldItalic.ttf']
}

export function systemFonts(): FontResolver {
  const winDir = process.env.WINDIR ?? 'C:/Windows'
  const dirs = [join(winDir, 'Fonts'), join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'Windows', 'Fonts')]
  const cache = new Map<string, string>()
  const find = (name: string): string | null => {
    for (const d of dirs) {
      const p = join(d, name)
      if (existsSync(p)) return p
    }
    return null
  }
  return {
    dir: dirs[0],
    file(family, bold, italic) {
      const key = `${family.toLowerCase()}|${bold}|${italic}`
      const hit = cache.get(key)
      if (hit) return hit
      const pick = (f: string): string | null => {
        const set = FAMILIES[f]
        return set ? find(set[(bold ? 1 : 0) + (italic ? 2 : 0)]) ?? find(set[0]) : null
      }
      const path = pick(family.toLowerCase()) ?? pick('arial') ?? join(dirs[0], 'arial.ttf')
      cache.set(key, path)
      return path
    }
  }
}
