import { mkdtempSync, mkdirSync, writeFileSync, existsSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('original-fs', async () => {
  const fs = await import('node:fs')
  return { default: fs }
})

describe('the native-files link next to a downloaded update', () => {
  it.runIf(process.platform === 'win32')('is removed as a link, the installed files stay', async () => {
    const { unlinkUnpacked } = await import('./unpacked-link')
    const root = mkdtempSync(join(tmpdir(), 'td-link-'))
    const target = join(root, 'app.asar.unpacked')
    mkdirSync(join(target, 'node_modules', 'koffi'), { recursive: true })
    writeFileSync(join(target, 'node_modules', 'koffi', 'index.js'), '')
    const link = join(root, '0.0.1.asar.unpacked')
    symlinkSync(target, link, 'junction')
    unlinkUnpacked(link)
    expect(existsSync(link)).toBe(false)
    expect(existsSync(join(target, 'node_modules', 'koffi', 'index.js'))).toBe(true)
    rmSync(root, { recursive: true, force: true })
  })
})
