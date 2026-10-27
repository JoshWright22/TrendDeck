import { describe, expect, it } from 'vitest'
import { DEFAULT_RECORDING_SETTINGS } from '@shared/obs'
import { cleanFilename, cleanFolder, cleanSettings, fill, isInsideDir, isRecordingFile, loadSettings, recordingFolder } from './rules'

describe('OBS recording settings rules', () => {
  it('defaults to keeping OBS profile and file names and recording into footage with auto-import', () => {
    expect(loadSettings(null)).toEqual({ profile: '', sceneCollection: '', folder: 'footage', filename: '', autoImport: true })
    expect(loadSettings({ folder: '..\\outside', autoImport: 'yes', profile: 'Talking head' })).toEqual({ ...DEFAULT_RECORDING_SETTINGS, profile: 'Talking head' })
  })

  it.each(['..', 'footage\\..\\..', 'C:\\Videos', '\\\\server\\share\\..', 'a:b', 'foot*age', 'trailing.'])('rejects folder rule %s', (rule) => {
    expect(() => cleanFolder(rule)).toThrow()
  })

  it('keeps folder rules inside the project folder', () => {
    expect(cleanFolder('')).toBe('footage')
    expect(cleanFolder(' footage/obs/ ')).toBe('footage\\obs')
    const dir = recordingFolder('C:\\Projects\\Brand\\Video', 'footage\\{brand}', { project: 'Video', brand: '../../evil' })
    expect(isInsideDir('C:\\Projects\\Brand\\Video', dir)).toBe(true)
  })

  it('fills tokens and keeps OBS % specifiers, without path separators', () => {
    expect(fill('{brand} {project} %CCYY-%MM-%DD', { project: 'My: video?', brand: 'Brand/One' })).toBe('Brand One My video %CCYY-%MM-%DD')
    expect(cleanFilename('{project} %hh-%mm')).toBe('{project} %hh-%mm')
    expect(() => cleanFilename('a/b')).toThrow()
    expect(() => cleanFilename('a\\b')).toThrow()
  })

  it('rejects unknown keys and bad types', () => {
    expect(() => cleanSettings(DEFAULT_RECORDING_SETTINGS, { password: '' })).toThrow()
    expect(() => cleanSettings(DEFAULT_RECORDING_SETTINGS, { autoImport: 'no' })).toThrow()
    expect(cleanSettings(DEFAULT_RECORDING_SETTINGS, { autoImport: false }).autoImport).toBe(false)
  })

  it('knows recording files', () => {
    expect(isRecordingFile('2026-10-26 10-00-00.mkv')).toBe(true)
    expect(isRecordingFile('take.MP4')).toBe(true)
    expect(isRecordingFile('notes.txt')).toBe(false)
  })
})
