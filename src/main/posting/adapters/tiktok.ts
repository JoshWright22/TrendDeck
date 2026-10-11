import type { Adapter } from './types'

const UPLOAD_MIN = 15 * 60 * 1000

export const tiktok: Adapter = {
  platform: 'tiktok',
  steps: [
    {
      name: 'open upload page',
      kind: 'goto',
      url: () => 'https://www.tiktok.com/tiktokstudio/upload'
    },
    {
      name: 'attach video',
      kind: 'file',
      find: ['input[type="file"][accept*="video"]', 'deep:input[type="file"]'],
      timeout: 45000
    },
    {
      name: 'fill caption',
      kind: 'type',
      // tiktok drops the file name in here first, typing replaces it
      find: [
        '.caption-editor [contenteditable="true"]',
        '.public-DraftEditor-content',
        'div[contenteditable="true"][role="combobox"]',
        'div[contenteditable="true"]'
      ],
      text: (p) => p.body,
      timeout: 120000
    },
    // let the hashtag suggestions settle
    { name: 'wait', kind: 'pause', ms: 800 }
  ],
  post: {
    find: ['button[data-e2e="post_video_button"]', 'text=Post'],
    timeout: UPLOAD_MIN
  },
  done: {
    texts: ['Your video has been uploaded', 'Your video is being uploaded', 'Video published'],
    url: /tiktokstudio\/content/
  }
}
