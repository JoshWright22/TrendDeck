// a real check of the visuals search against Openverse and Wikimedia Commons (no keys): searches,
// thumbnails, and one download into a temp project folder with its .credit.json. needs the network.
// run with: npm run check:visuals
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { downloadResult, searchVisuals } from '../src/main/visuals/search'
import { creditsText, imageInfo, provenanceFromResult, readCredits, writeToProject } from '../src/main/visuals/store'

const root = await fs.mkdtemp(join(tmpdir(), 'td-visuals-check-'))
const brand = 'check-brand'
const noKeys = async (): Promise<string> => ''
try {
  const only = process.argv.slice(2).filter((a) => a === 'openverse' || a === 'wikimedia') as ('openverse' | 'wikimedia')[]
  for (const provider of only.length ? only : (['openverse', 'wikimedia'] as const)) {
    const s = await searchVisuals(root, brand, { query: 'red fox', kind: 'image', license: 'commercial', count: 4, providers: [provider] }, noKeys)
    const note = s.providers.find((p) => p.provider === provider)
    console.log(`${provider}: ${s.results.length} results, ${s.results.filter((r) => r.thumb).length} thumbnails cached. ${note?.state} ${note?.note ?? ''}`)
    assert.equal(note?.state, 'ok', `${provider} search failed: ${note?.note}`)
    assert.ok(s.results.length > 0, `${provider} found nothing`)
    for (const r of s.results) {
      assert.ok(r.license.name && r.pageUrl.startsWith('http'), `${r.id} lacks a license or source`)
      console.log(`  ${r.id} "${r.title}" by ${r.author || '?'}, ${r.license.name}, ${r.width}x${r.height}`)
    }
    const r = s.results[0]
    const project = join(root, `Project ${provider}`)
    const { bytes } = await downloadResult(r)
    assert.ok(imageInfo(bytes), 'the download is not an image')
    const out = await writeToProject(project, { bytes, ext: r.ext || imageInfo(bytes)!.ext, stem: r.title, provenance: provenanceFromResult(r) })
    const st = await fs.stat(join(project, out.file))
    const side = JSON.parse(await fs.readFile(join(project, out.sidecar), 'utf8'))
    console.log(`  downloaded ${out.file} (${st.size} bytes), sidecar ${out.sidecar}: ${side.license.name}, ${side.retrievedAt}`)
    assert.equal(side.fileUrl, r.fileUrl)
    console.log(creditsText(await readCredits(project)).replace(/^/gm, '  '))
  }
  // video on Wikimedia and audio on Openverse: search only
  const vid = await searchVisuals(root, brand, { query: 'ocean waves', kind: 'video', count: 3, providers: ['wikimedia'] }, noKeys)
  console.log(`wikimedia video: ${vid.results.length} results, e.g. ${vid.results[0]?.id} ${vid.results[0]?.ext}`)
  const aud = await searchVisuals(root, brand, { query: 'rain', kind: 'audio', count: 3, providers: only.length ? only : ['openverse'] }, noKeys)
  console.log(`${only.length ? only[0] : "openverse"} audio: ${aud.results.length} results, e.g. ${aud.results[0]?.id} ${aud.results[0]?.license.name}`)
  console.log('visuals check passed')
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
