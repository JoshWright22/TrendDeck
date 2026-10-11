import type { Platform } from '@shared/posting'
import type { Adapter } from './types'
import { youtube } from './youtube'
import { tiktok } from './tiktok'
import { instagram } from './instagram'
import { x } from './x'
import { reddit } from './reddit'

// one small file per site, fix the selectors there when a site changes
export const ADAPTERS: Record<Platform, Adapter> = { youtube, tiktok, instagram, x, reddit }
