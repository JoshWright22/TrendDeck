import { describe, expect, it } from 'vitest'
import { ccLicense, creditLine, matchesOrientation, resultSize, visualFileStem } from '@shared/visuals'
import {
  extOf,
  interleave,
  openverseRequest,
  parseOpenverse,
  parsePexels,
  parsePixabay,
  parseWikimedia,
  pexelsRequest,
  pixabayRequest,
  plainText,
  providerError,
  titleFromSlug,
  webUrl,
  wikimediaRequest,
  type SearchQuery
} from './providers'
import { Pace, privateAddress } from './net'

// fixture shapes as the providers answer, trimmed to the fields TrendDeck reads. keys are blank or
// a plain placeholder, never anything key shaped

const q = (over: Partial<SearchQuery> = {}): SearchQuery => ({ query: 'red fox', kind: 'image', orientation: null, license: 'any-free', count: 12, ...over })

const OPENVERSE = {
  result_count: 3,
  results: [
    {
      id: 'a1b2',
      title: 'Red fox in snow',
      foreign_landing_url: 'https://www.flickr.com/photos/someone/123/',
      url: 'https://live.staticflickr.com/1/123_abc_b.jpg',
      creator: 'Jane Doe',
      creator_url: 'https://www.flickr.com/photos/someone',
      license: 'by-sa',
      license_version: '2.0',
      license_url: 'https://creativecommons.org/licenses/by-sa/2.0/',
      provider: 'flickr',
      attribution: '"Red fox in snow" by Jane Doe is licensed under CC BY-SA 2.0.',
      thumbnail: 'https://api.openverse.org/v1/images/a1b2/thumb/',
      width: 1024,
      height: 683,
      filesize: 250000,
      filetype: 'jpg'
    },
    { id: 'c3', title: 'Fox', url: 'https://example.org/fox.png', foreign_landing_url: 'https://example.org/fox', license: 'by-nc', license_version: '4.0', width: 500, height: 800, filetype: 'png' },
    { id: 'd4', title: 'Broken', url: 'javascript:alert(1)', foreign_landing_url: 'https://example.org/x', license: 'cc0' },
    { id: 'e5', title: 'Public fox', url: 'https://example.org/pd.jpg', foreign_landing_url: 'https://example.org/pd', license: 'pdm', width: 800, height: 800 }
  ]
}

const WIKIMEDIA = {
  batchcomplete: true,
  query: {
    pages: [
      {
        pageid: 222,
        ns: 6,
        title: 'File:Vulpes vulpes laying in snow.jpg',
        index: 2,
        imageinfo: [
          {
            user: 'Uploader',
            size: 3_400_000,
            width: 4000,
            height: 2667,
            mime: 'image/jpeg',
            thumburl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Vulpes.jpg/480px-Vulpes.jpg',
            url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Vulpes.jpg',
            descriptionurl: 'https://commons.wikimedia.org/wiki/File:Vulpes_vulpes_laying_in_snow.jpg',
            extmetadata: {
              LicenseShortName: { value: 'CC BY-SA 4.0' },
              LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0' },
              Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:Someone">Some&nbsp;One</a>' },
              AttributionRequired: { value: 'true' },
              ObjectName: { value: 'Vulpes vulpes laying in snow' }
            }
          }
        ]
      },
      {
        pageid: 111,
        ns: 6,
        title: 'File:Old fox drawing.png',
        index: 1,
        imageinfo: [
          {
            user: 'Archivist',
            size: 90_000,
            width: 600,
            height: 400,
            mime: 'image/png',
            thumburl: 'https://upload.wikimedia.org/thumb/old.png/480px-old.png',
            url: 'https://upload.wikimedia.org/old.png',
            descriptionurl: 'https://commons.wikimedia.org/wiki/File:Old_fox_drawing.png',
            extmetadata: { LicenseShortName: { value: 'Public domain' }, AttributionRequired: { value: 'false' } }
          }
        ]
      },
      { pageid: 333, ns: 6, title: 'File:Fox.gif', index: 3, imageinfo: [{ url: 'https://upload.wikimedia.org/fox.gif', mime: 'image/gif', width: 100, height: 100 }] }
    ]
  }
}

const PEXELS_PHOTOS = {
  total_results: 1,
  photos: [
    {
      id: 12345,
      width: 3000,
      height: 2000,
      url: 'https://www.pexels.com/photo/red-fox-in-the-woods-12345/',
      photographer: 'Sam Lens',
      photographer_url: 'https://www.pexels.com/@sam',
      alt: 'Red fox in the woods',
      src: { original: 'https://images.pexels.com/photos/12345/pexels-photo-12345.jpeg', medium: 'https://images.pexels.com/photos/12345/m.jpeg' }
    }
  ]
}

const PEXELS_VIDEOS = {
  videos: [
    {
      id: 777,
      width: 3840,
      height: 2160,
      duration: 14,
      url: 'https://www.pexels.com/video/fox-running-777/',
      image: 'https://images.pexels.com/videos/777/thumb.jpg',
      user: { name: 'Vid Maker', url: 'https://www.pexels.com/@vid' },
      video_files: [
        { id: 1, quality: 'uhd', file_type: 'video/mp4', width: 3840, height: 2160, link: 'https://videos.pexels.com/video-files/777/uhd.mp4' },
        { id: 2, quality: 'hd', file_type: 'video/mp4', width: 1920, height: 1080, link: 'https://videos.pexels.com/video-files/777/hd.mp4' },
        { id: 3, quality: 'sd', file_type: 'video/mp4', width: 640, height: 360, link: 'https://videos.pexels.com/video-files/777/sd.mp4' }
      ]
    }
  ]
}

const PIXABAY_PHOTOS = {
  total: 1,
  totalHits: 1,
  hits: [
    {
      id: 4242,
      pageURL: 'https://pixabay.com/photos/fox-animal-4242/',
      tags: 'fox, animal, wildlife',
      previewURL: 'https://cdn.pixabay.com/photo/fox_150.jpg',
      webformatURL: 'https://pixabay.com/get/fox_640.jpg',
      largeImageURL: 'https://pixabay.com/get/fox_1280.jpg',
      imageWidth: 4000,
      imageHeight: 3000,
      imageSize: 2_000_000,
      user: 'Wildlife Fan',
      user_id: 99
    }
  ]
}

const PIXABAY_VIDEOS = {
  hits: [
    {
      id: 5151,
      pageURL: 'https://pixabay.com/videos/fox-5151/',
      tags: 'fox',
      duration: 21,
      user: 'Filmer',
      user_id: 7,
      videos: {
        large: { url: 'https://cdn.pixabay.com/video/large.mp4', width: 3840, height: 2160, size: 90_000_000, thumbnail: 'https://cdn.pixabay.com/video/large.jpg' },
        medium: { url: 'https://cdn.pixabay.com/video/medium.mp4', width: 1920, height: 1080, size: 20_000_000, thumbnail: 'https://cdn.pixabay.com/video/medium.jpg' }
      }
    }
  ]
}

describe('openverse', () => {
  it('asks for the right kind and license', () => {
    const r = openverseRequest(q({ license: 'commercial', orientation: 'portrait' }))!
    expect(r.url).toMatch(/^https:\/\/api\.openverse\.org\/v1\/images\/\?/)
    expect(r.url).toContain('license_type=commercial')
    expect(r.url).toContain('aspect_ratio=tall')
    expect(openverseRequest(q({ license: 'no-attribution' }))!.url).toContain('license=cc0%2Cpdm')
    expect(openverseRequest(q({ kind: 'audio' }))!.url).toContain('/v1/audio/')
    expect(openverseRequest(q({ kind: 'gif' }))!.url).toContain('extension=gif')
    expect(openverseRequest(q({ kind: 'video' }))).toBeNull()
    expect(r.headers).toEqual({})
  })

  it('parses results with license, author and size, dropping bad links', () => {
    const out = parseOpenverse(OPENVERSE, q())
    expect(out.map((r) => r.id)).toEqual(['openverse:a1b2', 'openverse:c3', 'openverse:e5'])
    const [a] = out
    expect(a).toMatchObject({ provider: 'openverse', title: 'Red fox in snow', author: 'Jane Doe', width: 1024, height: 683, bytes: 250000, ext: 'jpg', thumb: '' })
    expect(a.license).toEqual({ name: 'CC BY-SA 2.0', url: 'https://creativecommons.org/licenses/by-sa/2.0/', attribution: true, commercial: true, modify: true })
    expect(a.attribution).toContain('Jane Doe')
    expect(out[1].license.commercial).toBe(false)
    expect(out[2].license).toMatchObject({ name: 'Public domain', attribution: false, commercial: true })
  })

  it('filters by license and orientation after the fact too', () => {
    expect(parseOpenverse(OPENVERSE, q({ license: 'commercial' })).map((r) => r.id)).toEqual(['openverse:a1b2', 'openverse:e5'])
    expect(parseOpenverse(OPENVERSE, q({ license: 'no-attribution' })).map((r) => r.id)).toEqual(['openverse:e5'])
    expect(parseOpenverse(OPENVERSE, q({ orientation: 'square' })).map((r) => r.id)).toEqual(['openverse:e5'])
  })

  it('survives junk', () => {
    expect(parseOpenverse(null, q())).toEqual([])
    expect(parseOpenverse({ results: 'nope' }, q())).toEqual([])
    expect(parseOpenverse({ results: [null, 3, {}] }, q())).toEqual([])
  })
})

describe('wikimedia', () => {
  it('searches files of the kind', () => {
    const u = new URL(wikimediaRequest(q({ kind: 'video' })).url)
    expect(u.host).toBe('commons.wikimedia.org')
    expect(u.searchParams.get('gsrsearch')).toBe('red fox filetype:video')
    expect(u.searchParams.get('gsrnamespace')).toBe('6')
    expect(new URL(wikimediaRequest(q({ kind: 'gif' })).url).searchParams.get('gsrsearch')).toContain('filemime:image/gif')
  })

  it('parses pages in search order with plain text authors', () => {
    const out = parseWikimedia(WIKIMEDIA, q())
    expect(out.map((r) => r.id)).toEqual(['wikimedia:111', 'wikimedia:222'])
    const fox = out[1]
    expect(fox).toMatchObject({ title: 'Vulpes vulpes laying in snow', author: 'Some One', width: 4000, height: 2667, bytes: 3_400_000, ext: 'jpg' })
    expect(fox.license).toMatchObject({ name: 'CC BY-SA 4.0', attribution: true, commercial: true, modify: true })
    expect(fox.pageUrl).toBe('https://commons.wikimedia.org/wiki/File:Vulpes_vulpes_laying_in_snow.jpg')
    expect(fox.attribution).toContain('via Wikimedia Commons')
    expect(out[0].license).toMatchObject({ name: 'Public domain', attribution: false })
    expect(out[0].attribution).toBe('')
  })

  it('keeps gifs apart from images', () => {
    expect(parseWikimedia(WIKIMEDIA, q({ kind: 'gif' })).map((r) => r.id)).toEqual(['wikimedia:333'])
  })
})

describe('pexels', () => {
  it('needs a key and sends it as a header only', () => {
    expect(pexelsRequest(q(), '')).toBeNull()
    const r = pexelsRequest(q({ orientation: 'landscape' }), 'placeholder')!
    expect(r.headers).toEqual({ Authorization: 'placeholder' })
    expect(r.url).not.toContain('placeholder')
    expect(r.url).toContain('orientation=landscape')
    expect(pexelsRequest(q({ kind: 'video' }), 'placeholder')!.url).toMatch(/^https:\/\/api\.pexels\.com\/videos\/search\?/)
    expect(pexelsRequest(q({ kind: 'audio' }), 'placeholder')).toBeNull()
  })

  it('parses photos', () => {
    const [p] = parsePexels(PEXELS_PHOTOS, q())
    expect(p).toMatchObject({ id: 'pexels:12345', title: 'Red fox in the woods', author: 'Sam Lens', ext: 'jpg', width: 3000 })
    expect(p.license).toMatchObject({ name: 'Pexels License', attribution: false, commercial: true })
  })

  it('picks a 1080p file for videos', () => {
    const [v] = parsePexels(PEXELS_VIDEOS, q({ kind: 'video' }))
    expect(v).toMatchObject({ id: 'pexels:v777', kind: 'video', fileUrl: 'https://videos.pexels.com/video-files/777/hd.mp4', width: 1920, height: 1080, duration: 14, title: 'Fox running', ext: 'mp4' })
  })
})

describe('pixabay', () => {
  it('puts the key in the query, as Pixabay wants', () => {
    expect(pixabayRequest(q(), '')).toBeNull()
    const u = new URL(pixabayRequest(q({ orientation: 'portrait' }), 'placeholder')!.url)
    expect(u.searchParams.get('key')).toBe('placeholder')
    expect(u.searchParams.get('orientation')).toBe('vertical')
    expect(u.searchParams.get('safesearch')).toBe('true')
    expect(pixabayRequest(q({ kind: 'gif' }), 'placeholder')).toBeNull()
  })

  it('parses photos and videos without the key in any url', () => {
    const [p] = parsePixabay(PIXABAY_PHOTOS, q())
    expect(p).toMatchObject({ id: 'pixabay:4242', title: 'Fox', author: 'Wildlife Fan', fileUrl: 'https://pixabay.com/get/fox_1280.jpg', bytes: 2_000_000 })
    expect(p.authorUrl).toBe('https://pixabay.com/users/Wildlife%20Fan-99/')
    const [v] = parsePixabay(PIXABAY_VIDEOS, q({ kind: 'video' }))
    expect(v).toMatchObject({ id: 'pixabay:v5151', fileUrl: 'https://cdn.pixabay.com/video/medium.mp4', height: 1080, duration: 21 })
    expect(JSON.stringify([p, v])).not.toContain('key=')
  })
})

describe('helpers', () => {
  it('cc licenses', () => {
    expect(ccLicense('by-nc-nd', '3.0')).toMatchObject({ name: 'CC BY-NC-ND 3.0', commercial: false, modify: false, attribution: true })
    expect(ccLicense('cc0')).toMatchObject({ name: 'CC0', attribution: false })
    expect(ccLicense('weird')).toMatchObject({ commercial: false })
  })

  it('urls, text and names', () => {
    expect(webUrl('//upload.wikimedia.org/x.jpg')).toBe('https://upload.wikimedia.org/x.jpg')
    expect(webUrl('file:///C:/x.png')).toBe('')
    expect(extOf('https://x.org/a/b.JPEG')).toBe('jpg')
    expect(extOf('https://x.org/a', 'video/quicktime')).toBe('mov')
    expect(plainText('<b>A&amp;B</b>&nbsp;c')).toBe('A&B c')
    expect(titleFromSlug('https://www.pexels.com/photo/red-fox-12345/')).toBe('Red fox')
    expect(visualFileStem('File:Vulpes Vulpes (fox).JPG')).toBe('vulpes-vulpes-fox')
    expect(visualFileStem('***')).toBe('visual')
    expect(matchesOrientation(1920, 1080, 'landscape')).toBe(true)
    expect(matchesOrientation(1080, 1920, 'landscape')).toBe(false)
    expect(resultSize({ width: 10, height: 20, duration: 65, bytes: 1500 })).toBe('10 by 20, 1:05, 2 KB')
  })

  it('credit lines', () => {
    const base = { origin: 'search' as const, provider: 'wikimedia' as const, title: 'Fox', author: 'Ann', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Fox.jpg', attribution: '', license: ccLicense('by', '4.0') }
    expect(creditLine(base)).toBe('"Fox" by Ann from Wikimedia Commons (https://commons.wikimedia.org/wiki/File:Fox.jpg), CC BY 4.0 https://creativecommons.org/licenses/by/4.0/')
    expect(creditLine({ ...base, attribution: 'Fox by Ann,  CC BY' })).toBe('Fox by Ann, CC BY')
    expect(creditLine({ ...base, origin: 'sketch' })).toBe('')
  })

  it('interleaves providers', () => {
    const mk = (p: string, n: number) => Array.from({ length: n }, (_, i) => ({ id: `${p}${i}` }) as never)
    expect(interleave([mk('a', 3), mk('b', 1), mk('c', 2)], 5).map((r: { id: string }) => r.id)).toEqual(['a0', 'b0', 'c0', 'a1', 'c1'])
  })

  it('errors never carry the url', () => {
    expect(providerError(403, 'pixabay')).toMatch(/Settings, Media sources/)
    expect(providerError(429, 'openverse')).toMatch(/Too many/)
  })
})

describe('net rules', () => {
  it('private addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.4', '172.20.1.1', '169.254.1.1', '::1', 'fd00::1', '::ffff:10.0.0.1', '0.0.0.0']) expect(privateAddress(ip)).toBe(true)
    for (const ip of ['8.8.8.8', '151.101.1.1', '2606:4700::1111']) expect(privateAddress(ip)).toBe(false)
  })

  it('paces each provider and backs off after a 429', () => {
    let t = 1_000_000
    const pace = new Pace(() => t)
    expect(pace.take('openverse')).toBeNull()
    expect(pace.take('openverse')).toBeGreaterThan(0)
    expect(pace.take('wikimedia')).toBeNull()
    t += 2000
    expect(pace.take('openverse')).toBeNull()
    pace.backOff('pexels', 60_000)
    expect(pace.take('pexels')).toBe(60_000)
  })
})
