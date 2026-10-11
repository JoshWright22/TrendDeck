// saved logins: the ui can save, replace and delete them and see the username, never the password

export const LOGIN_RESULTS = [
  'logged_in',
  'already_logged_in',
  'needs_code',
  'needs_user',
  'no_saved_login',
  'failed'
] as const
export type LoginResult = (typeof LOGIN_RESULTS)[number]

export interface SavedLoginInfo {
  siteId: string
  username: string
  hasNotes: boolean
  // sign-in page to open, empty means the app picks one
  loginUrl: string
  savedAt: number
}

export interface LoginAttempt {
  id: string
  at: number
  brandId: string
  siteId: string
  result: LoginResult
}

export interface VaultBrand {
  id: string
  name: string
  sites: { id: string; name: string; url: string; login: SavedLoginInfo | null }[]
}

export interface VaultState {
  // false when the os keychain can't be used, saving is refused then
  available: boolean
  reason: string
  brands: VaultBrand[]
  attempts: LoginAttempt[]
}

export interface LoginInput {
  username: string
  password: string
  notes: string
  loginUrl: string
}

export interface CodeRequest {
  id: string
  brandId: string
  siteName: string
}

export interface VaultApi {
  getState(): Promise<VaultState>
  // resolves to an error message, or '' when saved
  save(brandId: string, siteId: string, login: LoginInput): Promise<string>
  remove(brandId: string, siteId: string): Promise<void>
  onChanged(fn: () => void): () => void
  // a login hit a two-factor page, the app asks the user for the code
  onCodeRequest(fn: (req: CodeRequest) => void): () => void
  // null when the user cancels
  answerCode(id: string, code: string | null): Promise<void>
}
