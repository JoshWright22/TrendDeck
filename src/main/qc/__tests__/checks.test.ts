import { describe, expect, it } from 'vitest'
import {
  captionText,
  checkCaptions,
  checkDuration,
  checkFormat,
  checkHook,
  checkLoudness,
  checkResolution,
  checkSilences,
  guessTarget,
  parseBlack,
  parseFreezes,
  parseLoudness,
  parseProgressTime,
  parseSceneScores,
  parseSilences,
  wordErrorRate,
  type VideoInfo
} from '../checks'
import { parseProbe } from '../ffmpeg'

// log lines as ffmpeg 6 prints them
const LOG = `[blackdetect @ 000002823ea1cc80] black_start:2 black_end:3.03333 black_duration:1.03333
[blackdetect @ 000002823ea1cc80] black_start:10.5 black_end:10.7 black_duration:0.2
[silencedetect @ 0000028243e6d680] silence_start: 3.01871
[silencedetect @ 0000028243e6d680] silence_end: 5.50302 | silence_duration: 2.48431
[silencedetect @ 0000028243e6d680] silence_start: 11.2
[freezedetect @ 000001e2a2afd180] lavfi.freezedetect.freeze_start: 4
[freezedetect @ 000001e2a2afd180] lavfi.freezedetect.freeze_duration: 3.2
[freezedetect @ 000001e2a2afd180] lavfi.freezedetect.freeze_end: 7.2
[freezedetect @ 000001e2a2afd180] lavfi.freezedetect.freeze_start: 9
[Parsed_ebur128_0 @ 000001d0adf278c0] Summary:

  Integrated loudness:
    I:         -22.1 LUFS
    Threshold: -32.2 LUFS

  Loudness range:
    LRA:         7.4 LU
    Threshold: -44.6 LUFS
    LRA low:   -29.4 LUFS
    LRA high:  -22.0 LUFS

  True peak:
    Peak:      -0.4 dBFS
`

const INFO: VideoInfo = {
  duration: 30,
  width: 1080,
  height: 1920,
  fps: 30,
  videoCodec: 'h264',
  pixFmt: 'yuv420p',
  audioCodec: 'aac',
  container: 'mov,mp4'
}

describe('parsers', () => {
  it('reads the loudness summary', () => {
    expect(parseLoudness(LOG)).toEqual({ integrated: -22.1, truePeak: -0.4, range: 7.4 })
    expect(parseLoudness('nothing here')).toEqual({ integrated: null, truePeak: null, range: null })
  })

  it('reads silent tracks as -inf', () => {
    const l = parseLoudness('Summary:\n\n  Integrated loudness:\n    I:         -70.0 LUFS\n\n  True peak:\n    Peak:       -inf dBFS\n')
    expect(l.integrated).toBe(-70)
    expect(l.truePeak).toBe(-Infinity)
  })

  it('pairs silence starts and ends, an open one runs to the end', () => {
    expect(parseSilences(LOG, 14)).toEqual([
      { start: 3.01871, end: 5.50302 },
      { start: 11.2, end: 14 }
    ])
  })

  it('reads black stretches', () => {
    expect(parseBlack(LOG)).toEqual([
      { start: 2, end: 3.03333 },
      { start: 10.5, end: 10.7 }
    ])
  })

  it('reads freezes and ignores the duration lines', () => {
    expect(parseFreezes(LOG, 12)).toEqual([
      { start: 4, end: 7.2 },
      { start: 9, end: 12 }
    ])
  })

  it('reads a scene score per frame', () => {
    const log = [
      '[Parsed_metadata_2 @ 0] frame:0    pts:0       pts_time:0',
      '[Parsed_metadata_2 @ 0] lavfi.scene_score=0.000000',
      '[Parsed_metadata_2 @ 0] frame:1    pts:512     pts_time:0.0333333',
      '[Parsed_metadata_2 @ 0] lavfi.scene_score=0.453240'
    ].join('\r\n')
    expect(parseSceneScores(log)).toEqual([
      { t: 0, score: 0 },
      { t: 0.0333333, score: 0.45324 }
    ])
  })

  it('reads progress', () => {
    expect(parseProgressTime('frame=10\nout_time_us=1500000\nprogress=continue\nout_time_us=2000000\n')).toBe(2)
    expect(parseProgressTime('progress=continue')).toBeNull()
  })

  it('reads ffprobe json, rotated phone video comes out portrait', () => {
    const json = JSON.stringify({
      streams: [
        {
          codec_type: 'video',
          codec_name: 'h264',
          pix_fmt: 'yuv420p',
          width: 1920,
          height: 1080,
          avg_frame_rate: '30000/1001',
          side_data_list: [{ rotation: -90 }]
        },
        { codec_type: 'audio', codec_name: 'aac' }
      ],
      format: { duration: '12.5', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' }
    })
    const info = parseProbe(json)
    expect(info).toMatchObject({ width: 1080, height: 1920, videoCodec: 'h264', audioCodec: 'aac', duration: 12.5 })
    expect(info.fps).toBeCloseTo(29.97, 2)
  })
})

describe('captions', () => {
  it('takes the text out of srt and vtt', () => {
    const srt = '1\n00:00:00,000 --> 00:00:02,500\nHello <i>there</i>\n\n2\n00:00:02,500 --> 00:01:04,250\nGeneral Kenobi\n'
    expect(captionText(srt)).toEqual({ text: 'Hello there General Kenobi', end: 64.25 })
    const vtt = 'WEBVTT\n\n00:01.000 --> 00:03.000\nHello there\n'
    expect(captionText(vtt)).toEqual({ text: 'Hello there', end: 3 })
  })

  it('counts word errors, ignoring case and punctuation', () => {
    expect(wordErrorRate('Hello, there! General Kenobi.', 'hello there general kenobi')).toBe(0)
    expect(wordErrorRate('one two three four', 'one too three')).toBe(0.5)
    expect(wordErrorRate('', '')).toBe(0)
  })

  it('passes close captions and fails far ones', () => {
    const srt = '1\n00:00:00,000 --> 00:00:02,000\nthe quick brown fox jumps over the lazy dog\n'
    const names = { captions: 'a.srt', transcript: 'a.txt' }
    expect(checkCaptions(srt, 'The quick brown fox jumps over the lazy dog.', 30, names).status).toBe('pass')
    expect(checkCaptions(srt, 'something else entirely was said here today', 30, names).status).toBe('fail')
  })
})

describe('checks', () => {
  it('guesses the target from the shape', () => {
    expect(guessTarget({ width: 1920, height: 1080 })).toBe('youtube')
    expect(guessTarget({ width: 1080, height: 1920 })).toBe('shorts')
    expect(guessTarget({ width: 1080, height: 1080 })).toBe('square')
  })

  it('wants 1080x1920 for shorts and 16:9 for youtube', () => {
    expect(checkResolution(INFO, 'shorts').status).toBe('pass')
    expect(checkResolution({ ...INFO, width: 720, height: 1280 }, 'shorts').status).toBe('warn')
    expect(checkResolution(INFO, 'youtube').status).toBe('fail')
    expect(checkResolution({ ...INFO, width: 3840, height: 2160 }, 'youtube').status).toBe('pass')
    expect(checkResolution({ ...INFO, width: 640, height: 360 }, 'youtube').status).toBe('fail')
  })

  it('flags long shorts', () => {
    expect(checkDuration(INFO, 'shorts').status).toBe('pass')
    expect(checkDuration({ ...INFO, duration: 90 }, 'shorts').status).toBe('warn')
    expect(checkDuration({ ...INFO, duration: 200 }, 'shorts').status).toBe('fail')
  })

  it('flags odd codecs and a missing sound track', () => {
    expect(checkFormat(INFO).status).toBe('pass')
    expect(checkFormat({ ...INFO, audioCodec: '' }).status).toBe('warn')
    expect(checkFormat({ ...INFO, videoCodec: 'prores' }).status).toBe('warn')
    expect(checkFormat({ ...INFO, videoCodec: '' }).status).toBe('fail')
  })

  it('wants -16 to -12 LUFS and peaks at or under -1', () => {
    const [loud, peak] = checkLoudness(parseLoudness(LOG), true)
    expect(loud.status).toBe('warn')
    expect(peak.status).toBe('warn')
    const ok = checkLoudness({ integrated: -14, truePeak: -1.5, range: 5 }, true)
    expect(ok.map((c) => c.status)).toEqual(['pass', 'pass'])
    expect(checkLoudness({ integrated: -14, truePeak: 0.3, range: 5 }, true)[1].status).toBe('fail')
  })

  it('lists silences with their times', () => {
    const c = checkSilences(parseSilences(LOG, 14), 14, true)
    expect(c.status).toBe('warn')
    expect(c.at).toEqual([3.02, 11.2])
    expect(checkSilences([{ start: 0, end: 10 }], 10, true).status).toBe('fail')
  })

  it('wants a cut or movement in the first seconds', () => {
    const still = Array.from({ length: 90 }, (_, i) => ({ t: i / 30, score: 0.001 }))
    expect(checkHook(still).status).toBe('warn')
    const cut = still.map((s, i) => (i === 40 ? { ...s, score: 0.6 } : s))
    expect(checkHook(cut)).toMatchObject({ status: 'pass', at: [1.33] })
    expect(checkHook(still.map((s) => ({ ...s, score: 0.05 }))).status).toBe('pass')
  })
})
