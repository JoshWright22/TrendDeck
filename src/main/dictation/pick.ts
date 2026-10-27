// which local model suits this computer's graphics card. pure, so it's tested without electron.
//
// the rule:
// - no usable GPU (hardware acceleration off, WebGPU off, or only a software renderer like
//   Microsoft Basic Render or SwiftShader): Whisper Base, it runs well on the CPU
// - a discrete GPU (NVIDIA, a Radeon card, Intel Arc A or B series) with WebGPU: Whisper Large v3
//   Turbo, the most accurate model offered and quick on a real GPU
// - an integrated GPU (Intel, Radeon APU graphics, Apple, Qualcomm, anything unknown) with WebGPU:
//   Whisper Small, more accurate than Base and still quick there
// electron's basic GPU info has no memory size, so the kind of GPU stands in for VRAM.
// it only ever picks a local model, never a cloud API

export type GpuKind = 'discrete' | 'integrated' | 'software' | 'unknown'

export interface GpuDevice {
  vendor: string
  name: string
  active: boolean
  driver: string
}

export interface GpuFacts {
  gpus: GpuDevice[]
  // null when chromium doesn't say
  webgpu: boolean | null
  hardwareAcceleration: boolean
}

export interface ModelPick {
  id: string
  reason: string
}

const VENDORS: Record<number, string> = {
  0x10de: 'NVIDIA',
  0x1002: 'AMD',
  0x1022: 'AMD',
  0x8086: 'Intel',
  0x1414: 'Microsoft',
  0x106b: 'Apple',
  0x5143: 'Qualcomm',
  0x13b5: 'ARM',
  0x15ad: 'VMware',
  0x80ee: 'VirtualBox'
}

const text = (v: unknown, max = 120): string => (typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max) : '')

// electron's app.getGPUInfo('basic') and app.getGPUFeatureStatus() down to what's safe to show:
// vendor, the human name, the driver version and the feature switches. no device ids or paths
export function gpuFacts(basic: unknown, features: unknown, hardwareAcceleration: boolean): GpuFacts {
  const list = (basic as { gpuDevice?: unknown } | null)?.gpuDevice
  const gpus: GpuDevice[] = (Array.isArray(list) ? list : []).slice(0, 4).map((d: Record<string, unknown>) => {
    const vendor = VENDORS[Number(d?.vendorId)] ?? (text(d?.vendorString, 40) || 'Unknown')
    return {
      vendor,
      name: text(d?.deviceString) || text(d?.description) || `${vendor} graphics`,
      active: d?.active === true,
      driver: text(d?.driverVersion, 40)
    }
  })
  const status = (features && typeof features === 'object' ? features : {}) as Record<string, unknown>
  const webgpuStatus = typeof status.webgpu === 'string' ? status.webgpu : null
  const compositing = typeof status.gpu_compositing === 'string' ? status.gpu_compositing : ''
  return {
    gpus,
    webgpu: webgpuStatus === null ? null : webgpuStatus.startsWith('enabled'),
    hardwareAcceleration: hardwareAcceleration && (compositing === '' || compositing.startsWith('enabled'))
  }
}

// the GPU chromium draws with, else the first one listed
export function mainGpu(facts: GpuFacts): GpuDevice | undefined {
  return facts.gpus.find((g) => g.active) ?? facts.gpus[0]
}

export function gpuKind(gpu: GpuDevice | undefined): GpuKind {
  if (!gpu) return 'unknown'
  const name = gpu.name
  if (gpu.vendor === 'Microsoft' || /basic render|swiftshader|llvmpipe|software/i.test(name)) return 'software'
  if (gpu.vendor === 'VMware' || gpu.vendor === 'VirtualBox') return 'software'
  if (gpu.vendor === 'NVIDIA') return 'discrete'
  if (gpu.vendor === 'AMD') {
    // APU graphics: "AMD Radeon(TM) Graphics", "Radeon Vega 8 Graphics", "Radeon 780M"
    if (/radeon(\(tm\))?\s+(vega\s+\d+\s+)?graphics$|\b\d{3}M\b/i.test(name)) return 'integrated'
    return /radeon|firepro|instinct/i.test(name) ? 'discrete' : 'integrated'
  }
  if (gpu.vendor === 'Intel') return /arc(\(tm\))?\s+(pro\s+)?[ab]\d{3}/i.test(name) ? 'discrete' : 'integrated'
  if (gpu.vendor === 'Apple' || gpu.vendor === 'Qualcomm' || gpu.vendor === 'ARM') return 'integrated'
  return 'unknown'
}

export const PICK_CPU = 'whisper-base'
export const PICK_INTEGRATED = 'whisper-small'
export const PICK_DISCRETE = 'whisper-large-v3-turbo'

export function pickDictationModel(facts: GpuFacts): ModelPick {
  const gpu = mainGpu(facts)
  const kind = gpuKind(gpu)
  if (!facts.hardwareAcceleration) return { id: PICK_CPU, reason: 'Hardware acceleration is off, so dictation runs on the CPU, where Whisper Base is the best fit.' }
  if (facts.webgpu === false) return { id: PICK_CPU, reason: 'WebGPU is not available, so dictation runs on the CPU, where Whisper Base is the best fit.' }
  if (kind === 'software') return { id: PICK_CPU, reason: 'There is no hardware graphics card in use, so dictation runs on the CPU, where Whisper Base is the best fit.' }
  if (kind === 'discrete') return { id: PICK_DISCRETE, reason: `${gpu!.name} is a dedicated graphics card, which runs Whisper Large v3 Turbo, the most accurate model, quickly.` }
  return { id: PICK_INTEGRATED, reason: `${gpu?.name ?? 'This graphics card'} looks like built-in graphics, which runs Whisper Small well. Larger models would be slow.` }
}
