import { describe, expect, it } from 'vitest'
import { touchesPrivate } from './private-guard'
import { privateRules, withoutRules } from './claude'

const DIR = 'C:\\Users\\awsom\\AppData\\Roaming\\TrendDeck'

describe('touchesPrivate', () => {
  it('stops commands that name the folder any way', () => {
    for (const c of [
      'cat C:/Users/awsom/AppData/Roaming/TrendDeck/trenddeck.json',
      'type C:\\Users\\awsom\\AppData\\Roaming\\TrendDeck\\gateway\\x',
      'ls /c/Users/awsom/AppData/Roaming/TrendDeck',
      'dir %APPDATA%\\TrendDeck',
      'Get-ChildItem $env:APPDATA\\TrendDeck\\Partitions',
      'cat "$APPDATA/TrendDeck/Local State"',
      'cd ~/AppData/Roaming/TrendDeck && ls',
      '[System.Security.Cryptography.ProtectedData]::Unprotect($b, $null, 0)'
    ]) expect(touchesPrivate(c, DIR), c).toBe(true)
  })

  it("lets the agent's own room and everything else through", () => {
    for (const c of [
      'ls C:/Users/awsom/AppData/Roaming/TrendDeck/agent-room',
      'cat $APPDATA/TrendDeck/agent-room/notes.md',
      'ffprobe "C:/Users/awsom/Videos/Recordings/a.mkv"',
      'cat "$APPDATA/obs-studio/basic/profiles/AutoRec/recordEncoder.json"',
      'git status'
    ]) expect(touchesPrivate(c, DIR), c).toBe(false)
  })
})

describe('privateRules', () => {
  it("keeps claude code's file tools out of every entry but agent-room, in its //c/ form", () => {
    const rules = privateRules(DIR, ['trenddeck.json', 'agent-room', 'Partitions'])
    expect(rules).toContain('Read(//c/Users/awsom/AppData/Roaming/TrendDeck/trenddeck.json)')
    expect(rules).toContain('Read(//c/Users/awsom/AppData/Roaming/TrendDeck/Partitions/**)')
    expect(rules.some((r) => r.includes('agent-room'))).toBe(false)
  })
})

describe('withoutRules', () => {
  it('leaves the instructions out of the message, they go in the system prompt', () => {
    const rules = 'You are the agent.\nRule two.'
    expect(withoutRules(`${rules}\n\n## New message from the user\nhi`, rules)).toBe('## New message from the user\nhi')
    const again = `## TrendDeck's instructions, updated (these replace the ones from the start of this chat)\n${rules}\n\n## New message from the user\nhi`
    expect(withoutRules(again, rules)).toBe('\n## New message from the user\nhi')
    expect(withoutRules('hi', rules)).toBe('hi')
  })
})
