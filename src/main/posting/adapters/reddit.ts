import type { Adapter } from './types'

// the new submit page is all web components, most things sit in shadow roots
export const reddit: Adapter = {
  platform: 'reddit',
  steps: [
    {
      name: 'open submit page',
      kind: 'goto',
      url: (p) =>
        `https://www.reddit.com/r/${encodeURIComponent(p.subreddit || 'test')}/submit?type=${p.mediaPath ? 'IMAGE' : 'TEXT'}`
    },
    {
      name: 'fill title',
      kind: 'type',
      find: [
        'faceplate-textarea-input[name="title"] >>> textarea',
        'textarea[name="title"]',
        'deep:textarea[name="title"]'
      ],
      text: (p) => p.title
    },
    {
      name: 'attach media',
      kind: 'file',
      find: ['deep:input[type="file"]'],
      when: (p) => p.mediaPath !== ''
    },
    {
      name: 'fill body',
      kind: 'type',
      find: [
        'shreddit-composer div[contenteditable="true"]',
        'div[name="body"][contenteditable="true"]',
        'deep:div[contenteditable="true"][role="textbox"]',
        'deep:div[contenteditable="true"]'
      ],
      text: (p) => p.body,
      when: (p) => p.body.trim() !== ''
    }
  ],
  post: {
    find: [
      '#submit-post-button',
      'r-post-form-submit-button >>> button',
      'deep:button#submit-post-button',
      'text=Post'
    ],
    timeout: 3 * 60 * 1000
  },
  done: { url: /\/comments\// }
}
