export interface ObsPreferences {
  endpoint: string
  hasPassword: boolean
}

declare global {
  interface Window { trenddeckObs: ObsApi }
}

export interface ObsConnectionInput {
  endpoint: string
  importLocalPassword?: boolean
  clearPassword?: boolean
}

export interface ObsStatus {
  connected: boolean
  endpoint: string
  error?: string
  ownerBrandId?: string
  recording?: boolean
  streaming?: boolean
  currentProfile?: string
  profiles?: string[]
  currentScene?: string
  scenes?: string[]
  recordDirectory?: string
}

export interface ObsApi {
  preferences(brandId: string): Promise<ObsPreferences>
  configure(brandId: string, input: ObsConnectionInput): Promise<ObsPreferences>
  status(brandId: string): Promise<ObsStatus>
}

export const OBS_CHANNELS = {
  preferences: 'obs:preferences',
  configure: 'obs:configure',
  status: 'obs:status'
} as const
