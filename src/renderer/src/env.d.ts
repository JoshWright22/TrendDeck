// from package.json at build time, see electron.vite.config.ts
declare const __APP_VERSION__: string

interface ImportMetaEnv {
  // set to 1 at build time to use the craft mock when main has no craft side, for screenshots
  readonly VITE_CRAFT_MOCK?: string
}
