import { describe, expect, it } from 'vitest'
import {
  channelIdFromHtml,
  cleanChannel,
  decodeXml,
  fetchUploads,
  fetchVideoMetrics,
  formatOf,
  isoDuration,
  metricsFromReport,
  parseChannels,
  parsePlaylistPage,
  parseReport,
  parseRetention,
  parseRss,
  parseStudioCsv,
  parseVideos,
  reportUrl,
  withAuth,
  type FetchJson
} from './youtube'

// response shapes as the YouTube Data API v3 and Analytics API v2 document them.
// credentials in fixtures are blank on purpose

const AT = Date.UTC(2026, 9, 27)

const channels = {
  kind: 'youtube#channelListResponse',
  items: [{ kind: 'youtube#channel', id: 'UCabcdefghijklmnopqrstuv', snippet: { title: 'Test Channel' }, contentDetails: { relatedPlaylists: { likes: '', uploads: 'UUabcdefghijklmnopqrstuv' } } }]
}

const videos = {
  kind: 'youtube#videoListResponse',
  items: [
    {
      id: 'aaaaaaaaaaa',
      snippet: { publishedAt: '2026-09-01T15:00:00Z', title: 'Budget PC build', description: 'A cheap build', tags: ['pc', 'budget'] },
      contentDetails: { duration: 'PT12M30S' },
      statistics: { viewCount: '15230', likeCount: '812', commentCount: '97' }
    },
    {
      id: 'bbbbbbbbbbb',
      snippet: { publishedAt: '2026-09-05T15:00:00Z', title: 'Quick tip #shorts', description: '' },
      contentDetails: { duration: 'PT1M45S' },
      statistics: { viewCount: '40100' }
    },
    { id: 'ccccccccccc', snippet: { title: 'Odd one' }, contentDetails: { duration: 'P0D' }, statistics: {} },
    { snippet: { title: 'no id, dropped' } }
  ]
}

const report = {
  kind: 'youtubeAnalytics#resultTable',
  columnHeaders: [
    { name: 'video', columnType: 'DIMENSION', dataType: 'STRING' },
    { name: 'views', columnType: 'METRIC', dataType: 'INTEGER' },
    { name: 'engagedViews', columnType: 'METRIC', dataType: 'INTEGER' },
    { name: 'averageViewDuration', columnType: 'METRIC', dataType: 'INTEGER' },
    { name: 'averageViewPercentage', columnType: 'METRIC', dataType: 'FLOAT' },
    { name: 'likes', columnType: 'METRIC', dataType: 'INTEGER' },
    { name: 'comments', columnType: 'METRIC', dataType: 'INTEGER' },
    { name: 'shares', columnType: 'METRIC', dataType: 'INTEGER' },
    { name: 'subscribersGained', columnType: 'METRIC', dataType: 'INTEGER' }
  ],
  rows: [
    ['aaaaaaaaaaa', 15000, 14200, 312, 41.6, 800, 95, 40, 120],
    ['bbbbbbbbbbb', 40000, 31000, 52, 49.5, 2100, 30, 210, 60]
  ]
}

const retention = {
  columnHeaders: [{ name: 'elapsedVideoTimeRatio' }, { name: 'audienceWatchRatio' }, { name: 'relativeRetentionPerformance' }],
  rows: [
    [0.02, 0.81, 0.5],
    [0.01, 1.0, 0.5],
    [0.03, 0.7432, 0.52]
  ]
}

const rss = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
 <link rel="self" href="http://www.youtube.com/feeds/videos.xml?channel_id=UCabcdefghijklmnopqrstuv"/>
 <id>yt:channel:abcdefghijklmnopqrstuv</id>
 <yt:channelId>UCabcdefghijklmnopqrstuv</yt:channelId>
 <title>Test &amp; Channel</title>
 <entry>
  <id>yt:video:aaaaaaaaaaa</id>
  <yt:videoId>aaaaaaaaaaa</yt:videoId>
  <yt:channelId>UCabcdefghijklmnopqrstuv</yt:channelId>
  <title>Budget PC &quot;build&quot; &#8211; part 1</title>
  <link rel="alternate" href="https://www.youtube.com/watch?v=aaaaaaaaaaa"/>
  <published>2026-09-01T15:00:00+00:00</published>
  <media:group>
   <media:title>Budget PC</media:title>
   <media:description>A cheap build</media:description>
   <media:community>
    <media:starRating count="812" average="5.00" min="1" max="5"/>
    <media:statistics views="15230"/>
   </media:community>
  </media:group>
 </entry>
 <entry>
  <id>yt:video:bbbbbbbbbbb</id>
  <yt:videoId>bbbbbbbbbbb</yt:videoId>
  <title>Quick tip</title>
  <link rel="alternate" href="https://www.youtube.com/shorts/bbbbbbbbbbb"/>
  <published>2026-09-05T15:00:00+00:00</published>
  <media:group><media:community><media:statistics views="40100"/></media:community></media:group>
 </entry>
</feed>`

describe('Data API parsing', () => {
  it('reads ISO 8601 durations', () => {
    expect(isoDuration('PT12M30S')).toBe(750)
    expect(isoDuration('PT1H2M3S')).toBe(3723)
    expect(isoDuration('P1DT1S')).toBe(86401)
    expect(isoDuration('P0D')).toBe(0)
    expect(isoDuration('12:30')).toBeNull()
  })

  it('reads the channel and its uploads playlist', () => {
    expect(parseChannels(channels)).toEqual({ id: 'UCabcdefghijklmnopqrstuv', title: 'Test Channel', uploads: 'UUabcdefghijklmnopqrstuv' })
    expect(parseChannels({ items: [] })).toBeNull()
    expect(parsePlaylistPage({ items: [{ contentDetails: { videoId: 'aaaaaaaaaaa' } }, { contentDetails: {} }], nextPageToken: 'CDIQAA' })).toEqual({ ids: ['aaaaaaaaaaa'], next: 'CDIQAA' })
  })

  it('reads videos: counts as numbers, format from duration and #shorts, junk dropped', () => {
    const v = parseVideos(videos, AT)
    expect(v.map((x) => x.id)).toEqual(['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc'])
    expect(v[0]).toMatchObject({ title: 'Budget PC build', duration: 750, format: 'long', tags: ['pc', 'budget'], publishedAt: Date.parse('2026-09-01T15:00:00Z') })
    expect(v[0].metrics).toMatchObject({ views: 15230, likes: 812, comments: 97, ctr: null, sources: ['data-api'] })
    expect(v[1]).toMatchObject({ format: 'short', duration: 105 })
    expect(v[1].metrics?.likes).toBeNull()
    expect(v[2]).toMatchObject({ publishedAt: null, duration: 0, format: 'short' })
  })

  it('tells Shorts from long videos', () => {
    expect(formatOf(45)).toBe('short')
    expect(formatOf(150)).toBe('long')
    expect(formatOf(150, { text: 'tip #Shorts' })).toBe('short')
    expect(formatOf(150, { contentType: 'SHORTS' })).toBe('short')
    expect(formatOf(30, { contentType: 'VIDEO_ON_DEMAND' })).toBe('long')
    expect(formatOf(null, { shortsLink: true })).toBe('short')
    expect(formatOf(null)).toBe('long')
  })
})

describe('Analytics API parsing', () => {
  it('reads a report by its column names', () => {
    const rows = parseReport(report)
    expect(rows[1]).toMatchObject({ video: 'bbbbbbbbbbb', engagedViews: 31000, averageViewPercentage: 49.5 })
    expect(metricsFromReport(rows[0])).toEqual({ views: 15000, engagedViews: 14200, avgViewDuration: 312, avgViewPercent: 41.6, likes: 800, comments: 95, shares: 40, subsGained: 120 })
    expect(parseReport({ columnHeaders: [] })).toEqual([])
    expect(parseReport(null)).toEqual([])
  })

  it('reads the retention curve sorted by time', () => {
    expect(parseRetention(retention)).toEqual([
      { ratio: 0.01, watch: 1 },
      { ratio: 0.02, watch: 0.81 },
      { ratio: 0.03, watch: 0.743 }
    ])
  })

  it('builds report urls for the signed-in channel', () => {
    const u = new URL(reportUrl(['audienceWatchRatio'], { dimensions: 'elapsedVideoTimeRatio', filters: 'video==aaaaaaaaaaa', start: Date.UTC(2026, 8, 1), end: AT }))
    expect(u.searchParams.get('ids')).toBe('channel==MINE')
    expect(u.searchParams.get('startDate')).toBe('2026-09-01')
    expect(u.searchParams.get('endDate')).toBe('2026-10-27')
    expect(u.searchParams.get('filters')).toBe('video==aaaaaaaaaaa')
  })
})

describe('calls through a fake fetch', () => {
  it('pages through uploads and counts quota units, a bearer header with OAuth', async () => {
    const seen: { url: string; auth: string }[] = []
    const fetchJson: FetchJson = async (url, init) => {
      seen.push({ url, auth: init?.headers?.authorization ?? '' })
      if (url.includes('/playlistItems')) {
        return url.includes('pageToken') ? { items: [{ contentDetails: { videoId: 'bbbbbbbbbbb' } }] } : { items: [{ contentDetails: { videoId: 'aaaaaaaaaaa' } }], nextPageToken: 'NEXT' }
      }
      if (url.includes('/videos')) return videos
      throw new Error(`unexpected ${url}`)
    }
    const counter = { units: 0, analyticsCalls: 0 }
    const list = await fetchUploads(fetchJson, { kind: 'oauth', token: '' }, { id: 'UCabcdefghijklmnopqrstuv', title: '', uploads: 'UUabcdefghijklmnopqrstuv' }, counter, AT)
    expect(list).toHaveLength(3)
    expect(counter.units).toBe(3)
    expect(seen.every((s) => s.auth === 'Bearer ')).toBe(true)
    expect(seen.some((s) => s.url.includes('key='))).toBe(false)
    expect(seen.find((s) => s.url.includes('/videos'))?.url).toContain('id=aaaaaaaaaaa,bbbbbbbbbbb')
  })

  it('puts an API key in the query, not a header', () => {
    expect(withAuth('https://www.googleapis.com/youtube/v3/videos?id=x', { kind: 'key', key: '' })).toEqual({ url: 'https://www.googleapis.com/youtube/v3/videos?id=x&key=', headers: {} })
  })

  it('falls back to the metrics without engagedViews when the report refuses them', async () => {
    const asked: string[] = []
    const fetchJson: FetchJson = async (url) => {
      const metrics = new URL(url).searchParams.get('metrics') ?? ''
      asked.push(metrics)
      if (metrics.includes('engagedViews')) throw new Error('youtubeanalytics.googleapis.com said 400 badRequest: Unknown identifier (engagedViews)')
      return report
    }
    const counter = { units: 0, analyticsCalls: 0 }
    const m = await fetchVideoMetrics(fetchJson, '', AT - 30 * 86400_000, AT, counter)
    expect(asked).toHaveLength(2)
    expect(asked[1]).not.toContain('engagedViews')
    expect(m.get('aaaaaaaaaaa')?.views).toBe(15000)
    expect(counter).toEqual({ units: 0, analyticsCalls: 2 })
  })
})

describe('public channel data', () => {
  it('reads the RSS feed: ids, titles with entities, views, likes and Shorts links', () => {
    const f = parseRss(rss, AT)
    expect(f.channelTitle).toBe('Test & Channel')
    expect(f.channelId).toBe('UCabcdefghijklmnopqrstuv')
    expect(f.videos).toHaveLength(2)
    expect(f.videos[0]).toMatchObject({ id: 'aaaaaaaaaaa', title: 'Budget PC "build" – part 1', description: 'A cheap build', format: 'long', publishedAt: Date.parse('2026-09-01T15:00:00Z') })
    expect(f.videos[0].metrics).toMatchObject({ views: 15230, likes: 812, sources: ['rss'] })
    expect(f.videos[1]).toMatchObject({ format: 'short', url: 'https://www.youtube.com/shorts/bbbbbbbbbbb' })
    expect(parseRss('<feed></feed>', AT).videos).toEqual([])
    // a header id without its UC prefix gets it back
    const head = rss.split('<entry>')[0]
    expect(parseRss(rss.replace(head, head.replace('UCabcdefghijklmnopqrstuv</yt:channelId>', 'abcdefghijklmnopqrstuv</yt:channelId>')), AT).channelId).toBe('UCabcdefghijklmnopqrstuv')
  })

  it('finds a channel id in its page and cleans what the creator typed', () => {
    expect(channelIdFromHtml('<link rel="canonical" href="https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv">')).toBe('UCabcdefghijklmnopqrstuv')
    expect(channelIdFromHtml('{"externalId":"UCabcdefghijklmnopqrstuv"}')).toBe('UCabcdefghijklmnopqrstuv')
    expect(channelIdFromHtml('<html></html>')).toBe('')
    expect(cleanChannel('https://www.youtube.com/@SomeCreator/videos')).toBe('@SomeCreator')
    expect(cleanChannel('youtube.com/channel/UCabcdefghijklmnopqrstuv')).toBe('UCabcdefghijklmnopqrstuv')
    expect(cleanChannel('somecreator')).toBe('@somecreator')
    expect(cleanChannel('not a channel!')).toBe('')
    expect(decodeXml('&lt;b&gt; &#x41;&#66; <![CDATA[x & y]]>')).toBe('<b> AB x & y')
  })
})

describe('YouTube Studio export', () => {
  it('reads impressions and CTR per video and skips the total row', () => {
    const csv = [
      '﻿Content,Video title,Video publish time,Duration,Views,Average percentage viewed (%),Impressions,Impressions click-through rate (%)',
      'Total,,,,"55,330",44.1,"912,004",5.2',
      'aaaaaaaaaaa,"Budget PC build, part 1","Sep 1, 2026",750,15230,41.6,"310,500",4.86',
      'bbbbbbbbbbb,Quick tip,"Sep 5, 2026",105,40100,49.5,601504,6.1',
      ''
    ].join('\r\n')
    expect(parseStudioCsv(csv)).toEqual([
      { id: 'aaaaaaaaaaa', impressions: 310500, ctr: 4.86, views: 15230, avgViewPercent: 41.6 },
      { id: 'bbbbbbbbbbb', impressions: 601504, ctr: 6.1, views: 40100, avgViewPercent: 49.5 }
    ])
    expect(parseStudioCsv('Content,Views\naaaaaaaaaaa,10')).toEqual([])
  })
})
