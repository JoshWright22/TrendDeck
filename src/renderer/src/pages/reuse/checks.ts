import { SHORT_LIMITS, SHORT_NAMES, type ShortPlatform, type VideoInfo } from '@shared/reuse'

export interface Caption {
  title: string
  body: string
}

const gb = (n: number): string => `${(n / 1024 ** 3).toFixed(n >= 1024 ** 3 ? 0 : 1)} GB`

export const mb = (n: number): string => `${(n / 1024 ** 2).toFixed(1)} MB`

export function clock(s: number): string {
  const m = Math.floor(s / 60)
  return `${m}:${String(Math.round(s % 60)).padStart(2, '0')}`
}

// problems block the post, warnings just get shown
export function checkShort(
  p: ShortPlatform,
  video: VideoInfo | null,
  cap: Caption
): { problems: string[]; warnings: string[] } {
  const lim = SHORT_LIMITS[p]
  const name = SHORT_NAMES[p]
  const problems: string[] = []
  const warnings: string[] = []
  if (!video) problems.push('Pick a video first')
  else {
    if (video.error && !video.bytes) problems.push(video.error)
    if (video.bytes > lim.maxBytes) problems.push(`${name} files stop at ${gb(lim.maxBytes)}`)
    if (video.seconds) {
      if (video.seconds > lim.maxSeconds) problems.push(`${name} stops at ${clock(lim.maxSeconds)}, this is ${clock(video.seconds)}`)
      if (video.seconds < lim.minSeconds) problems.push(`${name} needs at least ${lim.minSeconds}s`)
    } else if (video.bytes) warnings.push("Length couldn't be read, check it yourself")
    if (video.width && video.height) {
      const ratio = video.width / video.height
      if (ratio >= 1) problems.push(`It's ${video.width}x${video.height}, Shorts need a vertical video`)
      else if (Math.abs(ratio - 9 / 16) > 0.02) warnings.push(`It's ${video.width}x${video.height}, not 9:16 so it gets bars or a crop`)
      if (video.height < 960) warnings.push('Under 1080p tall, it may look soft')
    }
  }
  if (lim.titleMax && !cap.title.trim()) problems.push(`${name} needs a title`)
  if (lim.titleMax && cap.title.length > lim.titleMax) problems.push(`${name} titles stop at ${lim.titleMax}`)
  if (cap.body.length > lim.captionMax) problems.push(`${name} captions stop at ${lim.captionMax}`)
  if (p === 'youtube' && !/#shorts\b/i.test(`${cap.title} ${cap.body}`) && video && video.seconds > 60) {
    warnings.push('Over a minute, add #Shorts so it lands on the Shorts shelf')
  }
  return { problems, warnings }
}
