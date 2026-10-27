import { describe, expect, it } from 'vitest'
import { secondsToTicks, sequenceDuration, type Keyframe } from '@shared/editor'
import { buildAss, buildRenderGraph, ffColor, filterPath, keyframeExpr, n, type FontResolver } from '../filtergraph'
import { buildEdit, STILL_PROBE, VIDEO_PROBE } from './fixture'

const fonts: FontResolver = { file: (f, bold) => `C:/Fonts/${f}${bold ? '-Bold' : ''}.ttf`, dir: 'C:/Fonts' }
const paths = { video: 'C:\\media\\clip.mp4', still: 'C:/media/logo.png' }

describe('filter graph', () => {
  it('matches the snapshot for a full edit', () => {
    const { session, seqId } = buildEdit(paths, { video: VIDEO_PROBE, still: STILL_PROBE })
    const seq = session.project.items[seqId]
    if (seq.kind !== 'sequence') throw new Error()
    const graph = buildRenderGraph(session.project, seqId, {
      from: 0,
      to: sequenceDuration(seq),
      tempDir: 'C:/tmp/job',
      audio: true,
      fonts,
      output: { width: 1920, height: 1080, fit: 'fit' }
    })
    expect(graph.seconds).toBe(6)
    expect(graph.maps).toEqual(['-map', '[vout]', '-map', '[aout]'])
    expect(graph.warnings).toEqual([])
    expect(graph.filter).toMatchSnapshot('filter')
    expect(graph.inputArgs).toMatchSnapshot('inputs')
    expect(graph.files.map((f) => f.name)).toEqual(['text0.txt', 'captions.ass'])
    // text goes through a file, so quotes, colons and percent signs need no escaping
    expect(graph.files[0].content).toBe("Hello {world}: it's 100%")
    expect(graph.filter).toContain("textfile='C\\:/tmp/job/text0.txt'")
    expect(graph.filter).toContain("ass=filename='C\\:/tmp/job/captions.ass'")
  })

  it('renders a one frame window with only the clips under it', () => {
    const { session, seqId, clipIds } = buildEdit(paths, { video: VIDEO_PROBE, still: STILL_PROBE })
    const at = secondsToTicks(4.5)
    const graph = buildRenderGraph(session.project, seqId, { from: at, to: at + secondsToTicks(1 / 30), tempDir: 'C:/tmp/f', audio: false, fonts })
    expect(graph.maps).toEqual(['-map', '[vout]'])
    // just the double speed clip: 1/30 s of timeline is 2/30 s of source starting at 1 s in
    expect(graph.inputArgs).toEqual(['-ss', '1', '-t', '0.066667', '-i', paths.video])
    expect(graph.filter).toContain('setpts=PTS/2')
    expect(clipIds.fast).toBeTruthy()
  })

  it('builds keyframe expressions with easing', () => {
    const keys: Keyframe[] = [
      { t: 0, value: 100, ease: 'linear' },
      { t: secondsToTicks(1), value: 200, ease: 'hold' },
      { t: secondsToTicks(2), value: 50, ease: 'linear' }
    ]
    const e = keyframeExpr(keys, (t) => t / secondsToTicks(1))
    expect(e).toBe('if(lt(t,0),100,if(lt(t,1),100+100*((t-0)/1),if(lt(t,2),200+-150*0,50)))')
  })

  it('escapes paths and colours for filter options', () => {
    expect(filterPath("C:\\Users\\o'neil\\a.ass")).toBe("'C\\:/Users/o'\\''neil/a.ass'")
    expect(ffColor('#ff8800', 0.5)).toBe('0xFF8800@0.5')
    expect(ffColor('#ff880080')).toBe('0xFF8800@0.501961')
    expect(n(1 / 3)).toBe('0.333333')
    expect(n(-0)).toBe('0')
  })

  it('writes ASS with wrapped, brace-free, range-relative captions', () => {
    const { session, seqId } = buildEdit(paths, { video: VIDEO_PROBE, still: STILL_PROBE })
    const seq = session.project.items[seqId]
    if (seq.kind !== 'sequence') throw new Error()
    const ass = buildAss(seq, seq.captionTracks, secondsToTicks(1), secondsToTicks(3))
    expect(ass).toContain('PlayResX: 640')
    expect(ass).toContain('Dialogue: 0,0:00:00.00,0:00:00.80,T0,,0,0,0,,First caption, with a comma')
    expect(ass).toContain('Dialogue: 0,0:00:01.00,0:00:02.00,T0,,0,0,0,,Second one')
  })
})
