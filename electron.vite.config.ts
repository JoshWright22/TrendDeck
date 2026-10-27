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
              // wasm-unsafe-eval and connect-src for the local Whisper worker: it compiles the onnx runtime and
              // fetches model files from td-media:, recordings come in as blob: urls
              "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: td-media:; media-src 'self' td-media: blob:; connect-src 'self' td-media: blob:"
          }
        }
      ]
    }
  }
}

// the onnx runtime files the local Whisper worker loads (wasm and webgpu both use the asyncify build).
// copied into the renderer output as ort/, never fetched from a CDN, see src/renderer/src/dictation
const ORT_FILES = ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']
function ortRuntime(): Plugin {
  const dir = resolve('node_modules/onnxruntime-web/dist')
  return {
    name: 'trenddeck-ort',
    configureServer(server) {
      server.middlewares.use('/ort/', (req, res, next) => {
        const name = (req.url ?? '').split('?')[0].replace(/^\//, '')
        if (!ORT_FILES.includes(name)) return next()
        res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript')
        res.end(readFileSync(resolve(dir, name)))
      })
    },
    generateBundle() {
      for (const name of ORT_FILES) this.emitFile({ type: 'asset', fileName: `ort/${name}`, source: readFileSync(resolve(dir, name)) })
    }
  }
}

export default defineConfig({
  main: {
    resolve: { alias: shared },
    build: {
      rollupOptions: {
        // electron's own fs without .asar support, for reading and writing update archives
        external: ['original-fs'],
        input: {
          // the launcher, picks the installed or a downloaded copy of the app code, see boot.ts
          boot: resolve('src/main/boot.ts'),
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
    resolve: {
      alias: {
        ...shared,
        // the runtime build that loads its wasm from ort/ (see ortRuntime) instead of embedding a
        // second copy of the 27 MB file in assets/
        'onnxruntime-web/webgpu': resolve('node_modules/onnxruntime-web/dist/ort.webgpu.min.mjs')
      }
    },
    plugins: [react(), buildCsp(), ortRuntime()],
    // the Whisper worker is an es module, transformers.js loads the runtime with import()
    worker: { format: 'es' },
    define: { __APP_VERSION__: JSON.stringify(version) },
    // smaller bundle, less to parse before the first paint
    build: { minify: true }
  }
})
