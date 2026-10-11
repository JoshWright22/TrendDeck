import type { Adapter } from './types'

const DIALOG = 'div[role="dialog"]'

// the web create dialog, videos come out as reels
export const instagram: Adapter = {
  platform: 'instagram',
  steps: [
    { name: 'open instagram', kind: 'goto', url: () => 'https://www.instagram.com/' },
    {
      name: 'open create',
      kind: 'click',
      find: ['svg[aria-label="New post"]', 'svg[aria-label="Create"]', 'text=Create']
    },
    // newer layouts ask post or live after create
    {
      name: 'pick post',
      kind: 'click',
      find: ['svg[aria-label="Post"]'],
      optional: true,
      timeout: 4000
    },
    {
      name: 'attach media',
      kind: 'file',
      find: [`${DIALOG} input[type="file"]`, 'form input[type="file"]', 'input[type="file"]']
    },
    // shown once per account the first time a video goes up
    {
      name: 'reels notice',
      kind: 'click',
      find: [`${DIALOG} text=OK`],
      optional: true,
      timeout: 5000
    },
    { name: 'next past crop', kind: 'click', find: [`${DIALOG} text=Next`], timeout: 60000 },
    { name: 'wait', kind: 'pause', ms: 800 },
    { name: 'next past edit', kind: 'click', find: [`${DIALOG} text=Next`] },
    {
      name: 'fill caption',
      kind: 'type',
      find: [
        `${DIALOG} div[aria-label^="Write a caption"]`,
        `${DIALOG} div[contenteditable="true"][role="textbox"]`,
        `${DIALOG} textarea`
      ],
      text: (p) => p.body,
      when: (p) => p.body.trim() !== ''
    }
  ],
  post: { find: [`${DIALOG} text=Share`], timeout: 60000 },
  done: {
    texts: ['Your post has been shared', 'Your reel has been shared', 'Post shared', 'Reel shared']
  }
}
