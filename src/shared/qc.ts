// pre-publish checks on an exported video in a project's folder. main runs them with ffmpeg,
// see src/main/qc/. the renderer asks through window.trenddeckQc, the agent through qc_run

// what the video is for. shorts covers Shorts, Reels and TikTok, all 9:16 at 1080x1920
export const QC_TARGETS = ['youtube', 'shorts', 'square'] as const
export type QcTarget = (typeof QC_TARGETS)[number]

export const QC_TARGET_NAMES: Record<QcTarget, string> = {
  youtube: 'YouTube 16:9',
  shorts: 'Shorts, Reels, TikTok 9:16',
  square: 'Square 1:1'
}

export type QcStatus = 'pass' | 'warn' | 'fail'

export interface QcCheck {
  id: string
  label: string
  status: QcStatus
  // one plain line on what was found
  detail: string
  // where in the video, in seconds, for things like silences and black frames
  at?: number[]
}

export interface QcReport {
  file: string
  target: QcTarget
  // the target was picked from the video's shape, not asked for
  guessed: boolean
  duration: number
  checks: QcCheck[]
  ranAt: number
}

export interface QcOptions {
  target?: QcTarget
  // file names in the project folder. when left out, a .srt or .vtt and a .txt named like the
  // video (or transcript.txt) are used if they're there
  captions?: string
  transcript?: string
}

// main -> renderer on 'qc:progress'
export interface QcProgress {
  brandId: string
  projectId: string
  file: string
  // 0..1
  progress: number
}

export interface QcApi {
  run(brandId: string, projectId: string, file: string, opts?: QcOptions): Promise<QcReport>
  onProgress(fn: (p: QcProgress) => void): () => void
}

declare global {
  interface Window {
    trenddeckQc: QcApi
  }
}
