import { describe, expect, it } from 'vitest'
import { newer } from './versions'

describe('desktop update ordering', () => {
  it.each([
    ['0.3.0', '0.3.0-beta.4', true],
    ['0.3.0-beta.4', '0.3.0', false],
    ['0.3.0-beta.10', '0.3.0-beta.4', true],
    ['0.3.0-beta.4', '0.3.0-beta.4', false],
    ['0.3.0-beta', '0.3.0-beta.1', false],
    ['0.4.0-beta.1', '0.3.0', true],
    ['1.0.0-rc.1', '1.0.0-beta.9', true],
    ['1.0.0+build.2', '1.0.0+build.1', false],
    ['invalid', '1.0.0', false]
  ])('compares %s with %s', (candidate, installed, expected) => {
    expect(newer(candidate, installed)).toBe(expected)
  })
})
