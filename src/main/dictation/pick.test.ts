import { describe, expect, it } from 'vitest'
import { LOCAL_MODELS } from '../../shared/dictation'
import { PICK_CPU, PICK_DISCRETE, PICK_INTEGRATED, gpuFacts, gpuKind, pickDictationModel, type GpuFacts } from './pick'

const facts = (name: string, vendorId: number, extra: Partial<GpuFacts> = {}): GpuFacts =>
  ({ ...gpuFacts({ gpuDevice: [{ active: true, vendorId, deviceId: 1234, deviceString: name, driverVersion: '32.0.15.6094' }] }, { webgpu: 'enabled', gpu_compositing: 'enabled' }, true), ...extra })

describe('gpuFacts', () => {
  it('keeps only the vendor, name, driver and switches', () => {
    const f = gpuFacts(
      { gpuDevice: [{ active: true, vendorId: 0x10de, deviceId: 0x2684, deviceString: 'NVIDIA GeForce RTX 4090', driverVersion: '32.0.15.6094', sub: 'x' }], machineModelName: 'secret box' },
      { webgpu: 'enabled', gpu_compositing: 'enabled' },
      true
    )
    expect(f).toEqual({ gpus: [{ vendor: 'NVIDIA', name: 'NVIDIA GeForce RTX 4090', active: true, driver: '32.0.15.6094' }], webgpu: true, hardwareAcceleration: true })
    expect(JSON.stringify(f)).not.toMatch(/2684|10836|secret box/)
  })

  it('reads off switches and odd input', () => {
    expect(gpuFacts(null, null, true)).toEqual({ gpus: [], webgpu: null, hardwareAcceleration: true })
    expect(gpuFacts({ gpuDevice: 'x' }, { webgpu: 'disabled_off', gpu_compositing: 'disabled_software' }, true)).toMatchObject({ webgpu: false, hardwareAcceleration: false })
    expect(gpuFacts({}, {}, false).hardwareAcceleration).toBe(false)
    expect(gpuFacts({ gpuDevice: [{ vendorId: 0x8086 }] }, {}, true).gpus[0]).toEqual({ vendor: 'Intel', name: 'Intel graphics', active: false, driver: '' })
  })
})

describe('gpuKind', () => {
  const kind = (name: string, vendorId: number): string => gpuKind(facts(name, vendorId).gpus[0])
  it('tells dedicated cards from built-in graphics', () => {
    expect(kind('NVIDIA GeForce RTX 3060 Laptop GPU', 0x10de)).toBe('discrete')
    expect(kind('AMD Radeon RX 7900 XTX', 0x1002)).toBe('discrete')
    expect(kind('AMD Radeon RX 6800M', 0x1002)).toBe('discrete')
    expect(kind('Intel(R) Arc(TM) A770 Graphics', 0x8086)).toBe('discrete')
    expect(kind('AMD Radeon(TM) Graphics', 0x1002)).toBe('integrated')
    expect(kind('AMD Radeon 780M Graphics', 0x1002)).toBe('integrated')
    expect(kind('Intel(R) Arc(TM) Graphics', 0x8086)).toBe('integrated')
    expect(kind('Intel(R) UHD Graphics 620', 0x8086)).toBe('integrated')
    expect(kind('Microsoft Basic Render Driver', 0x1414)).toBe('software')
    expect(kind('Google SwiftShader', 0x1ae0)).toBe('software')
    expect(gpuKind(undefined)).toBe('unknown')
  })
})

describe('pickDictationModel', () => {
  it('picks the most accurate model for a dedicated GPU with WebGPU', () => {
    const pick = pickDictationModel(facts('NVIDIA GeForce RTX 4070', 0x10de))
    expect(pick.id).toBe(PICK_DISCRETE)
    expect(pick.reason).toMatch(/RTX 4070/)
  })

  it('picks Small for built-in graphics and unknown GPUs', () => {
    expect(pickDictationModel(facts('Intel(R) Iris(R) Xe Graphics', 0x8086)).id).toBe(PICK_INTEGRATED)
    expect(pickDictationModel(facts('Some GPU', 0x9999)).id).toBe(PICK_INTEGRATED)
    expect(pickDictationModel({ gpus: [], webgpu: null, hardwareAcceleration: true }).id).toBe(PICK_INTEGRATED)
  })

  it('falls back to Base on the CPU without WebGPU or acceleration', () => {
    expect(pickDictationModel(facts('NVIDIA GeForce RTX 4090', 0x10de, { webgpu: false })).id).toBe(PICK_CPU)
    expect(pickDictationModel(facts('NVIDIA GeForce RTX 4090', 0x10de, { hardwareAcceleration: false })).id).toBe(PICK_CPU)
    expect(pickDictationModel(facts('Microsoft Basic Render Driver', 0x1414)).id).toBe(PICK_CPU)
  })

  it('uses the active GPU on a laptop with two', () => {
    const f = gpuFacts({
      gpuDevice: [
        { active: false, vendorId: 0x10de, deviceString: 'NVIDIA GeForce RTX 4060 Laptop GPU' },
        { active: true, vendorId: 0x8086, deviceString: 'Intel(R) UHD Graphics' }
      ]
    }, { webgpu: 'enabled' }, true)
    expect(pickDictationModel(f).id).toBe(PICK_INTEGRATED)
  })

  it('only picks models in the catalog', () => {
    for (const id of [PICK_CPU, PICK_INTEGRATED, PICK_DISCRETE]) expect(LOCAL_MODELS.some((m) => m.id === id)).toBe(true)
  })
})
