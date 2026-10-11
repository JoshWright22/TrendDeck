import type { Platform, PostItem } from '@shared/posting'

// selectors are tried in order, first visible match wins
//   plain css                 'button[data-testid="tweetButton"]'
//   into a shadow root        'faceplate-textarea-input[name="title"] >>> textarea'
//   a button by its text      'text=Next' or with a scope 'div[role="dialog"] text=Next'
//   anywhere, shadow or not   'deep:input[type="file"]'
export type Selectors = string[]

interface Base {
  // shows up in the self-check and in the log when it breaks
  name: string
  // ms to wait for the element, default 30s
  timeout?: number
  // when it's missing just move on
  optional?: boolean
  // skip the step for this post, e.g. no media attached
  when?: (post: PostItem) => boolean
}

export type Step =
  | (Base & { kind: 'goto'; url: (post: PostItem) => string })
  | (Base & { kind: 'click'; find: Selectors })
  | (Base & { kind: 'wait'; find: Selectors })
  | (Base & { kind: 'type'; find: Selectors; text: (post: PostItem) => string })
  | (Base & { kind: 'file'; find: Selectors })
  | (Base & { kind: 'pause'; ms: number })

export interface Adapter {
  platform: Platform
  steps: Step[]
  // the last button, the app stops here unless the brand lets it press Post
  post: { find: Selectors; timeout?: number }
  // any of these means the post went out
  done: { texts?: string[]; find?: Selectors; url?: RegExp }
}
