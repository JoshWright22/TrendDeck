import type { Adapter } from './types'

export const x: Adapter = {
  platform: 'x',
  steps: [
    { name: 'open composer', kind: 'goto', url: () => 'https://x.com/compose/post' },
    {
      name: 'fill post text',
      kind: 'type',
      find: ['div[data-testid="tweetTextarea_0"]', 'div[role="textbox"][contenteditable="true"]'],
      text: (p) => p.body
    },
    {
      name: 'attach media',
      kind: 'file',
      find: ['input[data-testid="fileInput"]', 'input[type="file"]'],
      when: (p) => p.mediaPath !== ''
    },
    {
      name: 'wait for media',
      kind: 'wait',
      find: ['div[data-testid="attachments"]', 'div[data-testid="tweetPhoto"]'],
      when: (p) => p.mediaPath !== '',
      optional: true,
      timeout: 60000
    }
  ],
  post: {
    find: ['button[data-testid="tweetButton"]', 'button[data-testid="tweetButtonInline"]'],
    timeout: 5 * 60 * 1000
  },
  done: {
    texts: ['Your post was sent'],
    find: ['div[data-testid="toast"] a[href*="/status/"]']
  }
}
