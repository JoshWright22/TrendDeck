import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_LOCAL_MODEL, LOCAL_CONFIG_FILES, LOCAL_MODELS, customRepoId, localModel, prefsFor, variantFiles,
  type LocalModelProgress
} from '../../shared/dictation'

const dirs = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => dirs.userData } }))

import {
  addCustomModel, cancelDownload, deleteModel, downloadModel, fileUrl, findModel, installedDtypes, isInstalled, modelsState,
  removeCustomModel, servedModelFile, variantDir
} from './models'

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  dirs.userData = mkdtempSync(join(tmpdir(), 'td-stt-'))
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(dirs.userData, { recursive: true, force: true })
})

const content = (path: string): Uint8Array => new Uint8Array(Buffer.from(`file ${path}`))
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')

// a fake Hugging Face: the tree api lists every file with its sha256, resolve serves it.
// short: files the server cuts off. hang: requests that never answer until aborted
function hub(opts: { files?: string[]; short?: string[]; hang?: boolean; config?: unknown } = {}): void {
  const body = (path: string): Uint8Array =>
    path === 'config.json' && opts.config ? new Uint8Array(Buffer.from(JSON.stringify(opts.config))) : content(path)
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input)
    if (opts.hang && url.includes('/resolve/')) {
      return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
    }
    const tree = /\/api\/models\/[^/]+\/[^/]+\/tree\/main(\/onnx)?$/.exec(url)
    if (tree) {
      const inOnnx = !!tree[1]
      const all = opts.files ?? LOCAL_MODELS.flatMap((m) => Object.keys(m.variants).flatMap((d) => variantFiles(m, d as never)))
      const list = [...new Set(all)].filter((p) => p.startsWith('onnx/') === inOnnx).map((path) => {
        const b = body(path)
        return { type: 'file', path, size: b.byteLength, oid: 'x', lfs: { oid: sha256(b) } }
      })
      return Response.json(list)
    }
    const file = url.split('/resolve/main/')[1]
    if (file) {
      const b = body(file)
      return new Response(new Uint8Array(opts.short?.includes(file) ? b.slice(0, 3) : b))
    }
    return new Response('nope', { status: 404 })
  })
}

describe('local model catalog', () => {
  it('lists Whisper, Distil-Whisper and Moonshine with unique ids and loadable variants', () => {
    const ids = LOCAL_MODELS.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(expect.arrayContaining([
      'whisper-tiny', 'whisper-tiny.en', 'whisper-base', 'whisper-base.en', 'whisper-small', 'whisper-small.en', 'whisper-medium',
      'whisper-medium.en', 'whisper-large-v3-turbo', 'distil-small.en', 'moonshine-tiny', 'moonshine-base'
    ]))
    expect(localModel(DEFAULT_LOCAL_MODEL)).toBeDefined()
    for (const m of LOCAL_MODELS) {
      expect(m.repo).toMatch(/^onnx-community\//)
      expect(m.variants[m.defaultDtype]).toBeDefined()
      expect(m.englishOnly).toBe(/\.en$/.test(m.id) || m.family === 'moonshine')
      for (const [dtype, v] of Object.entries(m.variants)) {
        const files = variantFiles(m, dtype as never)
        expect(files).toEqual(expect.arrayContaining(LOCAL_CONFIG_FILES))
        expect(files.filter((f) => f.endsWith('.onnx'))).toHaveLength(2)
        expect(v!.bytes).toBeGreaterThan(10_000_000)
      }
    }
    // only the timestamped Whisper exports give exact word times
    expect(localModel('whisper-base')!.wordTimes).toBe('exact')
    expect(localModel('distil-small.en')!.wordTimes).toBe('approximate')
    expect(localModel('toString')).toBeUndefined()
  })

  it('picks the files transformers.js loads for each dtype', () => {
    const base = localModel('whisper-base')!
    expect(variantFiles(base, 'q8')).toEqual(expect.arrayContaining(['onnx/encoder_model.onnx', 'onnx/decoder_model_merged_quantized.onnx']))
    expect(variantFiles(base, 'q4')).toEqual(expect.arrayContaining(['onnx/encoder_model_q4.onnx', 'onnx/decoder_model_merged_q4.onnx']))
    expect(variantFiles(base, 'fp16')).toEqual(expect.arrayContaining(['onnx/encoder_model_fp16.onnx', 'onnx/decoder_model_merged_fp16.onnx']))
    expect(variantFiles(localModel('whisper-medium')!, 'fp32')).toEqual([])
  })

  it('falls back to the default dtype when a saved one does not exist for the model', () => {
    const medium = localModel('whisper-medium')!
    expect(prefsFor(medium, {})).toEqual({ dtype: 'q4', device: 'auto' })
    expect(prefsFor(medium, { 'whisper-medium': { dtype: 'fp32', device: 'webgpu' } })).toEqual({ dtype: 'q4', device: 'webgpu' })
    expect(prefsFor(medium, { 'whisper-medium': { dtype: 'q8', device: 'wasm' } })).toEqual({ dtype: 'q8', device: 'wasm' })
  })

  it('accepts only onnx-community repos as custom models', () => {
    expect(customRepoId('onnx-community/whisper-large-v3')).toBe('custom-whisper-large-v3')
    for (const bad of ['openai/whisper-large-v3', 'onnx-community/../x', 'onnx-community/', 'onnx-community/a/b', 'onnx-community/a b']) {
      expect(customRepoId(bad)).toBeNull()
    }
  })

  it('downloads only from huggingface.co', () => {
    expect(fileUrl(localModel('whisper-base')!, 'onnx/encoder_model.onnx'))
      .toBe('https://huggingface.co/onnx-community/whisper-base_timestamped/resolve/main/onnx/encoder_model.onnx')
  })
})

describe('local model downloads', () => {
  it('downloads a variant, checks each file, reports progress and writes the manifest last', async () => {
    hub()
    const events: LocalModelProgress[] = []
    await downloadModel('whisper-tiny', 'q8', (p) => events.push(p))
    for (const call of fetchMock.mock.calls) expect(String(call[0])).toMatch(/^https:\/\/huggingface\.co\//)
    expect(isInstalled('whisper-tiny', 'q8')).toBe(true)
    expect(isInstalled('whisper-tiny', 'q4')).toBe(false)
    expect(installedDtypes('whisper-tiny')).toEqual(['q8'])
    expect(events[0].state).toBe('downloading')
    expect(events.at(-1)).toMatchObject({ state: 'done', id: 'whisper-tiny', dtype: 'q8' })
    const dir = variantDir('whisper-tiny', 'q8')
    expect(dir).toBe(join(dirs.userData, 'stt', 'models', 'whisper-tiny', 'q8'))
    expect(existsSync(join(dir, 'manifest.json'))).toBe(true)
    expect(existsSync(join(dir, 'onnx', 'encoder_model.onnx.part'))).toBe(false)
    const state = await modelsState()
    expect(state.models.find((m) => m.id === 'whisper-tiny')).toEqual({ id: 'whisper-tiny', installed: ['q8'], downloading: [] })
    expect(state.diskBytes).toBeGreaterThan(0)
  })

  it('keeps several models downloaded side by side and deletes one dtype or all', async () => {
    hub()
    await downloadModel('whisper-tiny', 'q8', () => {})
    await downloadModel('whisper-tiny', 'q4', () => {})
    await downloadModel('moonshine-tiny', 'q8', () => {})
    expect(installedDtypes('whisper-tiny')).toEqual(['q8', 'q4'])
    expect(isInstalled('moonshine-tiny', 'q8')).toBe(true)
    await deleteModel('whisper-tiny', 'q4')
    expect(installedDtypes('whisper-tiny')).toEqual(['q8'])
    await deleteModel('whisper-tiny')
    expect(existsSync(join(dirs.userData, 'stt', 'models', 'whisper-tiny'))).toBe(false)
    expect(isInstalled('moonshine-tiny', 'q8')).toBe(true)
    await expect(deleteModel('../x')).rejects.toThrow('Unknown')
  })

  it('refuses a file that arrives short and leaves no partial behind', async () => {
    hub({ short: ['onnx/encoder_model.onnx'] })
    const events: LocalModelProgress[] = []
    await expect(downloadModel('whisper-tiny', 'q8', (p) => events.push(p))).rejects.toThrow('incompletely')
    expect(isInstalled('whisper-tiny', 'q8')).toBe(false)
    expect(existsSync(join(variantDir('whisper-tiny', 'q8'), 'onnx', 'encoder_model.onnx.part'))).toBe(false)
    expect(events.at(-1)?.state).toBe('error')
  })

  it('refuses a dtype the model does not have', async () => {
    await expect(downloadModel('whisper-medium', 'fp32', () => {})).rejects.toThrow('no fp32')
    await expect(downloadModel('nope', 'q8', () => {})).rejects.toThrow('Unknown')
  })

  it('cancels a running download', async () => {
    hub({ hang: true })
    const events: LocalModelProgress[] = []
    const pending = downloadModel('whisper-tiny', 'q8', (p) => events.push(p))
    await vi.waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/resolve/'))).toBe(true))
    expect((await modelsState()).models.find((m) => m.id === 'whisper-tiny')!.downloading).toHaveLength(1)
    cancelDownload('whisper-tiny', 'q8')
    await expect(pending).rejects.toThrow('cancelled')
    expect(events.at(-1)?.state).toBe('cancelled')
    expect(isInstalled('whisper-tiny', 'q8')).toBe(false)
  })
})

describe('custom models', () => {
  it('adds an onnx-community Whisper repo with the dtypes it has, then removes it', async () => {
    const files = [...LOCAL_CONFIG_FILES, 'onnx/encoder_model_q4.onnx', 'onnx/decoder_model_merged_q4.onnx', 'onnx/encoder_model.onnx']
    hub({ files, config: { model_type: 'whisper' } })
    const info = await addCustomModel('onnx-community/whisper-large-v3')
    expect(info).toMatchObject({ id: 'custom-whisper-large-v3', family: 'whisper', defaultDtype: 'q4', wordTimes: 'approximate', custom: true })
    expect(Object.keys(info.variants)).toEqual(['q4'])
    expect(findModel('custom-whisper-large-v3')?.repo).toBe('onnx-community/whisper-large-v3')
    await downloadModel(info.id, 'q4', () => {})
    expect(isInstalled(info.id, 'q4')).toBe(true)
    await removeCustomModel(info.id)
    expect(findModel(info.id)).toBeUndefined()
    expect(existsSync(join(dirs.userData, 'stt', 'models', info.id))).toBe(false)
  })

  it('refuses repos that are not speech models', async () => {
    hub({ config: { model_type: 'llama' } })
    await expect(addCustomModel('onnx-community/some-llm')).rejects.toThrow('Only Whisper and Moonshine')
    await expect(addCustomModel('openai/whisper-large-v3')).rejects.toThrow('onnx-community')
    await expect(addCustomModel('onnx-community/whisper-base_timestamped')).rejects.toThrow('already in the list')
  })
})

describe('serving model files to the worker', () => {
  it('serves only the listed files of a finished download', async () => {
    hub()
    await downloadModel('whisper-tiny', 'q8', () => {})
    const dir = variantDir('whisper-tiny', 'q8')
    expect(servedModelFile('/whisper-tiny/q8/config.json')).toBe(join(dir, 'config.json'))
    expect(servedModelFile('/whisper-tiny/q8/onnx/encoder_model.onnx')).toBe(join(dir, 'onnx', 'encoder_model.onnx'))
    writeFileSync(join(dir, 'secret.txt'), 'x')
    mkdirSync(join(dirs.userData, 'dictation'), { recursive: true })
    writeFileSync(join(dirs.userData, 'dictation', 'config.json'), '{}')
    for (const path of [
      '/whisper-tiny/q8/secret.txt', '/whisper-tiny/q8/manifest.json', '/whisper-tiny/q8/../../../dictation/config.json',
      '/whisper-tiny/q8/%2e%2e/%2e%2e/%2e%2e/dictation/config.json', '/whisper-tiny/q8/onnx%2f..%2f..%2fconfig.json',
      '/whisper-tiny/q8/onnx/encoder_model_q4.onnx', '/whisper-tiny/q4/config.json', '/whisper-base/q8/config.json',
      '/whisper-tiny/config.json', '/../dictation/config.json', '/whisper-tiny', '/', '/whisper-tiny/q8/%E0%A4%A'
    ]) expect(servedModelFile(path)).toBeNull()
    expect(readFileSync(servedModelFile('/whisper-tiny/q8/config.json')!, 'utf8')).toBe('file config.json')
  })

  it('serves nothing from an unfinished download', () => {
    mkdirSync(join(variantDir('whisper-tiny', 'q8'), 'onnx'), { recursive: true })
    writeFileSync(join(variantDir('whisper-tiny', 'q8'), 'config.json'), '{}')
    expect(servedModelFile('/whisper-tiny/q8/config.json')).toBeNull()
  })
})
