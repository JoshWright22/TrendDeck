import { describe, expect, it } from 'vitest'
import { markUserScroll, userScrolledRecently } from './scrollIntent'

describe('chat scroll intent', () => {
  it('counts a scroll as yours for a moment after you scrolled, not the chat growing on its own', () => {
    const el = { dataset: {} } as unknown as HTMLElement
    expect(userScrolledRecently(el)).toBe(false)
    markUserScroll(el)
    expect(userScrolledRecently(el)).toBe(true)
    expect(userScrolledRecently(el, Date.now() + 2000)).toBe(false)
  })
})
