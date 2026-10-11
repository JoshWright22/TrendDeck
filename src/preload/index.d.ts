import type { TrendDeckApi } from '@shared/types'

declare global {
  interface Window {
    trenddeck: TrendDeckApi
  }
}

export {}
