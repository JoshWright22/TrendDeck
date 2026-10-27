// the sections of Settings, in order. the window shows them, the agent's open_settings names one
export const SETTINGS_SECTIONS = [
  'Brand', 'Sites', 'Ad blocker', 'Tabs', 'Trends', 'Posting pace', 'Agents', 'Agent access', 'MCP servers', 'Context', 'Channels',
  'Media sources', 'Dictation', 'OBS', 'Craft apps', 'Storage', 'Saved logins', 'About'
] as const

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

export const isSettingsSection = (v: unknown): v is SettingsSection => typeof v === 'string' && (SETTINGS_SECTIONS as readonly string[]).includes(v)
