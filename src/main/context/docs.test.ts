import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { extractPdfText, parseCMap, scanDocs, searchTexts, snippetAround, textOf, tokenize } from './docs'
import { isTranscriptFile, scanTranscripts, stripCaptions } from './transcripts'

// a tiny pdf put together by hand: one page, one font, a compressed content stream
function buildPdf(content: string, extraObjs: { body: string; stream?: Buffer }[] = [], fontBody = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'): Buffer {
  const stream = deflateSync(Buffer.from(content, 'latin1'))
  const objs: { body: string; stream?: Buffer }[] = [
    { body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    { body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>' },
    { body: `<< /Length ${stream.length} /Filter /FlateDecode >>`, stream },
    { body: fontBody },
    ...extraObjs
  ]
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')]
  objs.forEach((o, i) => {
    parts.push(Buffer.from(`${i + 1} 0 obj\n${o.body}\n`, 'latin1'))
    if (o.stream) parts.push(Buffer.from('stream\n', 'latin1'), o.stream, Buffer.from('\nendstream\n', 'latin1'))
    parts.push(Buffer.from('endobj\n', 'latin1'))
  })
  parts.push(Buffer.from(`trailer\n<< /Root 1 0 R /Size ${objs.length + 1} >>\n%%EOF\n`, 'latin1'))
  return Buffer.concat(parts)
}

describe('pdf text', () => {
  it('reads Tj, TJ and quote operators from a FlateDecode stream', () => {
    const pdf = buildPdf(
      [
        'BT /F1 24 Tf 72 712 Td (Brand voice guide) Tj ET',
        'BT /F1 12 Tf 72 680 Td [(Talk to ) -250 (the viewer) 120 (,)] TJ',
        '0 -14 Td (Escaped \\(parens\\) and \\\\ slash) Tj',
        "(Second line) '",
        '<48656c6c6f20686578> Tj ET'
      ].join('\n')
    )
    const text = extractPdfText(pdf)
    expect(text).toContain('Brand voice guide')
    expect(text).toContain('Talk to the viewer,')
    expect(text).toContain('Escaped (parens) and \\ slash')
    expect(text).toContain('Second line')
    expect(text).toContain('Hello hex')
  })

  it('uses a ToUnicode map for two byte fonts', () => {
    const cmap = Buffer.from(
      [
        'begincmap',
        '1 begincodespacerange <0000> <FFFF> endcodespacerange',
        '2 beginbfchar <0001> <0048> <0002> <0069> endbfchar',
        '1 beginbfrange <0010> <0012> <0061> endbfrange',
        'endcmap'
      ].join('\n'),
      'latin1'
    )
    const pdf = buildPdf(
      'BT /F1 12 Tf 72 700 Td <00010002> Tj 0 -14 Td <001000110012> Tj ET',
      [{ body: `<< /Length ${cmap.length} >>`, stream: cmap }],
      '<< /Type /Font /Subtype /Type0 /BaseFont /Inter /Encoding /Identity-H /ToUnicode 6 0 R >>'
    )
    const text = extractPdfText(pdf)
    expect(text).toContain('Hi')
    expect(text).toContain('abc')
  })

  it('joins glyphs placed one by one and breaks lines by position', () => {
    // the way chrome prints: every glyph has its own Td, spaces come in their own BT
    const cmap = Buffer.from('1 begincodespacerange <0000> <FFFF> endcodespacerange 3 beginbfchar <0001> <0048> <0002> <0069> <0003> <0020> endbfchar', 'latin1')
    const content = [
      '1 0 0 -1 0 792 cm',
      'BT /F1 20 Tf 1 0 0 -1 0 32 Tm 0 -30 Td <0001> Tj 12 0 Td <0002> Tj ET',
      'BT /F1 20 Tf 1 0 0 -1 0 32 Tm 22 -30 Td <0003> Tj ET',
      'BT /F1 20 Tf 1 0 0 -1 0 32 Tm 27 -30 Td <0001> Tj 12 0 Td <0002> Tj ET',
      'BT /F1 20 Tf 1 0 0 -1 0 32 Tm 0 0 Td <00010002> Tj ET'
    ].join('\n')
    const pdf = buildPdf(
      content,
      [
        { body: `<< /Length ${cmap.length} >>`, stream: cmap },
        { body: '<< /Type /Font /Subtype /CIDFontType2 /DW 1000 /W [1 [600 500 250]] >>' }
      ],
      '<< /Type /Font /Subtype /Type0 /Encoding /Identity-H /DescendantFonts [7 0 R] /ToUnicode 6 0 R >>'
    )
    expect(extractPdfText(pdf)).toBe('Hi Hi\nHi')
  })

  it('gives nothing for broken or textless files', () => {
    expect(extractPdfText(Buffer.from('not a pdf at all'))).toBe('')
    expect(extractPdfText(buildPdf('q 100 0 0 100 0 0 cm /Im1 Do Q'))).toBe('')
  })

  it('parses bfrange arrays', () => {
    const c = parseCMap('1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfrange <41> <42> [<0058> <0059>] endbfrange')
    expect(c.bytes).toBe(1)
    expect(c.map.get(0x41)).toBe('X')
    expect(c.map.get(0x42)).toBe('Y')
  })

  it('textOf reads markdown and text', () => {
    expect(textOf('a.md', Buffer.from('﻿# Title\r\n\r\n\r\n\r\nBody   text'))).toBe('# Title\n\nBody text')
    expect(textOf('a.png', Buffer.from('x'))).toBe('')
  })
})

describe('captions', () => {
  it('strips srt cue numbers and timestamps', () => {
    const srt = '1\n00:00:01,000 --> 00:00:03,500\nHey everyone\n\n2\n00:00:03,500 --> 00:00:06,000\n<i>welcome back</i>\nto the channel\n\n'
    expect(stripCaptions(srt)).toBe('Hey everyone\nwelcome back\nto the channel')
  })

  it('strips vtt headers, notes, tags and repeated lines', () => {
    const vtt = [
      'WEBVTT',
      'Kind: captions',
      'Language: en',
      '',
      'NOTE this is a note',
      'that spans lines',
      '',
      'intro',
      '00:00.000 --> 00:02.000 align:start position:0%',
      'so<00:00:00.500><c> today</c> we test',
      '',
      '00:00:02.000 --> 00:00:04.000',
      'so today we test',
      '<v Josh>the new lens</v>',
      ''
    ].join('\n')
    expect(stripCaptions(vtt)).toBe('so today we test\nthe new lens')
  })

  it('knows transcript files by name', () => {
    expect(isTranscriptFile('ep1.srt')).toBe(true)
    expect(isTranscriptFile('ep1.VTT')).toBe(true)
    expect(isTranscriptFile('ep1 transcript.txt')).toBe(true)
    expect(isTranscriptFile('Captions-final.txt')).toBe(true)
    expect(isTranscriptFile('notes.txt')).toBe(false)
    expect(isTranscriptFile('video.mp4')).toBe(false)
  })
})

describe('search', () => {
  const items = [
    { name: 'guide/voice.md', text: `Intro. ${'filler words here. '.repeat(60)}Our tone is calm and direct, never hype. We talk to the viewer as a friend. ${'more filler. '.repeat(60)}` },
    { name: 'thumbnails.md', text: 'Thumbnails use big faces and three words max.' },
    { name: 'tone-notes.txt', text: 'Nothing else here.' }
  ]

  it('tokenizes to unique lowercase words', () => {
    expect(tokenize('Tone, TONE and a 4K hype!')).toEqual(['tone', 'and', '4k', 'hype'])
  })

  it('ranks by hits with a boost for file names', () => {
    const hits = searchTexts(items, 'tone', 5)
    expect(hits.map((h) => h.item.name)).toEqual(['tone-notes.txt', 'guide/voice.md'])
    const calm = searchTexts(items, 'calm direct tone', 5)
    expect(calm[0].item.name).toBe('guide/voice.md')
    expect(searchTexts(items, 'zebra', 5)).toEqual([])
    expect(searchTexts(items, 'faces', 1)).toHaveLength(1)
  })

  it('cuts a snippet of about 400 chars around the best hit', () => {
    const [hit] = searchTexts(items, 'calm hype', 5)
    expect(hit.snippet).toContain('calm and direct, never hype')
    expect(hit.snippet.startsWith('...')).toBe(true)
    expect(hit.snippet.endsWith('...')).toBe(true)
    expect(hit.snippet.length).toBeLessThanOrEqual(410)
    expect(snippetAround('short text', ['text'])).toBe('short text')
  })
})

describe('folders', () => {
  let root = ''
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'td-context-'))
    await mkdir(join(root, 'docs', 'sub'), { recursive: true })
    await mkdir(join(root, 'docs', '.hidden'), { recursive: true })
    await mkdir(join(root, 'docs', 'node_modules'), { recursive: true })
    await writeFile(join(root, 'docs', 'a.md'), '# Alpha')
    await writeFile(join(root, 'docs', 'sub', 'b.txt'), 'Bravo')
    await writeFile(join(root, 'docs', 'sub', 'c.pdf'), buildPdf('BT /F1 12 Tf (Charlie pdf) Tj ET'))
    await writeFile(join(root, 'docs', 'image.png'), 'x')
    await writeFile(join(root, 'docs', '.hidden', 'd.md'), 'hidden')
    await writeFile(join(root, 'docs', 'node_modules', 'e.md'), 'module')
    await mkdir(join(root, 'proj', 'exports'), { recursive: true })
    await writeFile(join(root, 'proj', 'exports', 'final.srt'), '1\n00:00:00,000 --> 00:00:01,000\nHello there\n')
    await writeFile(join(root, 'proj', 'notes.txt'), 'not a transcript')
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('indexes docs and reuses unchanged files', async () => {
    const dir = join(root, 'docs')
    const first = await scanDocs(dir, null, 1)
    expect(first.files.map((f) => [f.file, f.text])).toEqual([
      ['a.md', '# Alpha'],
      ['sub/b.txt', 'Bravo'],
      ['sub/c.pdf', 'Charlie pdf']
    ])
    // a cached text for an unchanged file is kept as is
    const fake = { ...first, files: first.files.map((f) => (f.file === 'a.md' ? { ...f, text: 'cached' } : f)) }
    const second = await scanDocs(dir, fake, 2)
    expect(second.files.find((f) => f.file === 'a.md')?.text).toBe('cached')
    await writeFile(join(dir, 'a.md'), '# Alpha two')
    await utimes(join(dir, 'a.md'), new Date(), new Date(Date.now() + 5000))
    const third = await scanDocs(dir, fake, 3)
    expect(third.files.find((f) => f.file === 'a.md')?.text).toBe('# Alpha two')
  })

  it('finds transcripts in project folders', async () => {
    const list = await scanTranscripts([{ name: 'My video', dir: join(root, 'proj') }])
    expect(list).toEqual([{ project: 'My video', file: 'exports/final.srt', text: 'Hello there' }])
  })
})
