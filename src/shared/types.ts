export interface Site {
  id: string
  name: string
  url: string
}

export interface Brand {
  id: string
  name: string
  keywords: string[]
  sites: Site[]
}

export interface AppData {
  version: 1
  activeBrandId: string | null
  chatOpen: boolean
  brands: Brand[]
}

export const DEFAULT_SITES: ReadonlyArray<Omit<Site, 'id'>> = [
  { name: 'Reddit', url: 'https://www.reddit.com' },
  { name: 'X', url: 'https://x.com' },
  { name: 'Instagram', url: 'https://www.instagram.com' },
  { name: 'TikTok', url: 'https://www.tiktok.com' },
  { name: 'YouTube', url: 'https://www.youtube.com' },
  { name: 'YouTube Studio', url: 'https://studio.youtube.com' },
  { name: 'vidIQ', url: 'https://app.vidiq.com' },
  { name: '1of10', url: 'https://1of10.com' }
]

// brand ids end up in a session partition name, so keep them boring
export const ID_PATTERN = /^[a-zA-Z0-9-]{1,64}$/

export function partitionFor(brandId: string): string {
  return `persist:brand-${brandId}`
}

export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

export interface TrendDeckApi {
  loadData(): Promise<AppData>
  saveData(data: AppData): Promise<void>
  clearBrandSession(brandId: string): Promise<void>
}
