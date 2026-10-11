import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { readFileSync } from 'node:fs'

const shared = { '@shared': resolve('src/shared') }
const version = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version

// only in the built app, the dev server needs inline scripts and a websocket for hot reload
function buildCsp(): Plugin {
  return {
    name: 'trenddeck-csp',
    apply: 'build',
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          injectTo: 'head-prepend',
          attrs: {
            'http-equiv': 'Content-Security-Policy',
            content:
              "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: td-media:; media-src 'self' td-media:"
          }
        }
      ]
    }
  }
}

export default defineConfig({
  main: {
    resolve: { alias: shared },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          // the ad blocker parses its lists off the main thread
          'adblock-worker': resolve('src/main/adblock-worker.ts')
        }
      }
    }
  },
  preload: {
    resolve: { alias: shared },
    build: {
      // site preloads run sandboxed, so the blocker's preload gets bundled in
      externalizeDeps: { exclude: ['@ghostery/adblocker-electron-preload'] },
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          adblock: resolve('src/preload/adblock.ts')
        }
      }
    }
  },
  renderer: {
    resolve: { alias: shared },
    plugins: [react(), buildCsp()],
    define: { __APP_VERSION__: JSON.stringify(version) },
    // smaller bundle, less to parse before the first paint
    build: { minify: true }
  }
})
