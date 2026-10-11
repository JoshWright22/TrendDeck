import type { Adapter } from './types'

const UPLOAD_MIN = 15 * 60 * 1000
const NEXT = ['#next-button', 'ytcp-button#next-button']

// studio's upload dialog, opened straight from youtube.com/upload
export const youtube: Adapter = {
  platform: 'youtube',
  steps: [
    { name: 'open upload page', kind: 'goto', url: () => 'https://www.youtube.com/upload' },
    {
      name: 'attach video',
      kind: 'file',
      find: [
        'ytcp-uploads-file-picker input[type="file"]',
        'input[name="Filedata"]',
        'deep:input[type="file"]'
      ],
      timeout: 45000
    },
    {
      name: 'fill title',
      kind: 'type',
      // youtube puts the file name in here first, typing replaces it
      find: ['#title-textarea #textbox', 'ytcp-video-title #textbox', '[aria-label^="Add a title"]'],
      text: (p) => p.title,
      timeout: 60000
    },
    {
      name: 'fill description',
      kind: 'type',
      find: [
        '#description-textarea #textbox',
        'ytcp-video-description #textbox',
        '[aria-label^="Tell viewers"]'
      ],
      text: (p) => p.body,
      when: (p) => p.body.trim() !== ''
    },
    {
      name: 'not made for kids',
      kind: 'click',
      find: [
        'tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]',
        '[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]'
      ]
    },
    { name: 'next to elements', kind: 'click', find: NEXT },
    { name: 'wait', kind: 'pause', ms: 800 },
    { name: 'next to checks', kind: 'click', find: NEXT },
    { name: 'wait', kind: 'pause', ms: 800 },
    { name: 'next to visibility', kind: 'click', find: NEXT },
    {
      name: 'pick public',
      kind: 'click',
      find: ['tp-yt-paper-radio-button[name="PUBLIC"]', '[name="PUBLIC"]'],
      when: (p) => p.visibility === 'public'
    },
    {
      name: 'pick unlisted',
      kind: 'click',
      find: ['tp-yt-paper-radio-button[name="UNLISTED"]', '[name="UNLISTED"]'],
      when: (p) => p.visibility === 'unlisted'
    },
    {
      name: 'pick private',
      kind: 'click',
      find: ['tp-yt-paper-radio-button[name="PRIVATE"]', '[name="PRIVATE"]'],
      when: (p) => p.visibility === 'private'
    }
  ],
  post: { find: ['#done-button', 'ytcp-button#done-button'], timeout: UPLOAD_MIN },
  done: {
    find: ['ytcp-video-share-dialog tp-yt-paper-dialog[opened]', 'ytcp-uploads-still-processing-dialog'],
    texts: ['Video published', 'Video saved']
  }
}
