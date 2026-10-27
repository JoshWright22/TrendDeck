import { QC_TARGETS } from '@shared/qc'
import { ToolError, type GatewayTool } from '../gateway/types'
import { obj, oneOf, str } from '../gateway/validate'
import { projectVideos, QcError, runQc } from './run'

// qc_run for the agent: the same checks the window runs, before a video goes out
export function qcTools(): GatewayTool[] {
  return [
    {
      name: 'qc_run',
      title: 'Check a video before posting',
      description:
        "Runs pre-publish checks on an exported video in a project's folder: length, size, frame rate and codecs for the target " +
        '(youtube 16:9, shorts 9:16 1080x1920 for Shorts, Reels and TikTok, square 1:1), loudness (aim for -16 to -12 LUFS, peaks at or under -1 dBTP), ' +
        'long silences, black frames, frozen picture, whether the first 3 seconds have a cut or movement, and caption word errors against a transcript ' +
        'when a .srt or .vtt and a .txt named like the video (or transcript.txt) are there. Leave file out to list the videos in the folder. ' +
        'Each check comes back pass, warn or fail with a plain detail and, where it applies, the times in seconds. Read only, nothing is changed.',
      risk: 'read',
      inputSchema: obj(
        {
          projectId: str('the project the video belongs to', 64, 1),
          file: str('the video file name in the project folder, e.g. final.mp4. leave out to list the videos', 260, 1),
          target: oneOf('what it is for, guessed from its shape when left out', QC_TARGETS),
          captions: str('a caption file name in the folder, .srt or .vtt', 260, 1),
          transcript: str('a transcript file name in the folder, plain text', 260, 1)
        },
        ['projectId']
      ),
      summarize: (_turn, a) => (a.file ? `Check ${String(a.file)}` : 'List the project videos'),
      run: async (turn, a) => {
        const projectId = String(a.projectId)
        try {
          if (!a.file) {
            const videos = await projectVideos(turn.brandId, projectId)
            if (!videos.length) return 'no videos in the project folder yet'
            return { videos: videos.map((v) => ({ file: v.name, modified: new Date(v.modified).toISOString() })) }
          }
          return await runQc(turn.brandId, projectId, String(a.file), { target: a.target, captions: a.captions, transcript: a.transcript })
        } catch (err) {
          if (err instanceof QcError) throw new ToolError(err.message)
          throw err
        }
      }
    }
  ]
}
