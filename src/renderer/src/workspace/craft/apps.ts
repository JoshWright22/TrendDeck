// the Craft suite as the renderer names it before list() answers: workspace keys and labels.
// main's list() is the source of truth for everything else

// these four have their own workspace key, the rest open as craft:<id>
export const OWN_KEYS = ['filmcraft', 'photocraft', 'soundcraft', 'effectcraft'] as const

export const CRAFT_NAMES: Record<string, string> = {
  filmcraft: 'FilmCraft',
  photocraft: 'PhotoCraft',
  soundcraft: 'SoundCraft',
  effectcraft: 'EffectCraft',
  designcraft: 'DesignCraft',
  vectorcraft: 'VectorCraft',
  lightcraft: 'LightCraft',
  pdfcraft: 'PdfCraft',
  wordcraft: 'WordCraft',
  deckcraft: 'DeckCraft',
  gridcraft: 'GridCraft',
  cadcraft: 'CADCraft',
  figcraft: 'FigCraft'
}

export const CRAFT_PREFIX = 'craft:'

export function craftKey(appId: string): string {
  return (OWN_KEYS as readonly string[]).includes(appId) ? appId : `${CRAFT_PREFIX}${appId}`
}

// the app a workspace key opens, null when it isn't a craft key
export function craftAppOf(key: string): string | null {
  if ((OWN_KEYS as readonly string[]).includes(key)) return key
  return key.startsWith(CRAFT_PREFIX) ? key.slice(CRAFT_PREFIX.length) || null : null
}

export function craftName(appId: string): string {
  return CRAFT_NAMES[appId] ?? appId.charAt(0).toUpperCase() + appId.slice(1)
}
