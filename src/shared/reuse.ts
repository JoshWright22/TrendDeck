// short video everywhere, used by main, preload and the shorts page

import type { Platform } from './posting'

export const SHORT_PLATFORMS = ['youtube', 'instagram', 'tiktok'] as const satisfies readonly Platform[]
export type ShortPlatform = (typeof SHORT_PLATFORMS)[number]

export const SHORT_NAMES: Record<ShortPlatform, string> = {
  youtube: 'YouTube Short',
  instagram: 'Instagram Reel',
  tiktok: 'TikTok'
}

// limits for a short vertical video posted from the web, kept on the safe side
export const SHORT_LIMITS: Record<
  ShortPlatform,
  { maxSeconds: number; minSeconds: number; maxBytes: number; captionMax: number; titleMax: number }
> = {
  youtube: { maxSeconds: 180, minSeconds: 1, maxBytes: 256 * 1024 ** 3, captionMax: 5000, titleMax: 100 },
  instagram: { maxSeconds: 900, minSeconds: 3, maxBytes: 4 * 1024 ** 3, captionMax: 2200, titleMax: 0 },
  tiktok: { maxSeconds: 600, minSeconds: 3, maxBytes: 4 * 1024 ** 3, captionMax: 2200, titleMax: 0 }
}

export interface VideoInfo {
  path: string
  bytes: number
  // 0 when the file couldn't be read as mp4/mov
  seconds: number
  width: number
  height: number
  error: string
}

export interface ChannelShort {
  id: string
  title: string
  url: string
  views: string
}

export interface ShortsList {
  channelUrl: string
  shorts: ChannelShort[]
  error: string
}

// how fast posts go out, per platform
export interface PaceRule {
  perDay: number
  gapMinutes: number
}

export interface PaceSettings {
  rules: Record<Platform, PaceRule>
  // up to this many random minutes get added when a post is held back
  jitterMinutes: number
}

export const DEFAULT_PACE: PaceSettings = {
  rules: {
    youtube: { perDay: 3, gapMinutes: 120 },
    tiktok: { perDay: 4, gapMinutes: 90 },
    instagram: { perDay: 3, gapMinutes: 120 },
    x: { perDay: 15, gapMinutes: 20 },
    reddit: { perDay: 5, gapMinutes: 60 }
  },
  jitterMinutes: 12
}

export interface ReuseApi {
  getPace(): Promise<PaceSettings>
  setPace(pace: PaceSettings): Promise<PaceSettings>
  // size, length and frame size of a local video
  probe(path: string): Promise<VideoInfo>
  // reads the brand's shorts shelf from its logged in youtube session
  listShorts(brandId: string, channelUrl: string): Promise<ShortsList>
}
