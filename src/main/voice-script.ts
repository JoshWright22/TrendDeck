import { registerTools } from './gateway/call'
import { BRAND_MEMORY_TOOLS, setupBrandMemory } from './brand-memory'
import { SCRIPT_TOOLS, setupScripts } from './scripts'
import { setupTakes, TAKE_TOOLS } from './takes'

export { dropBrandMemory } from './brand-memory'

// talk-first scripts, takes and the brand memory that learns from them, set up together
export function setupVoiceScript(): void {
  registerTools(SCRIPT_TOOLS)
  registerTools(TAKE_TOOLS)
  registerTools(BRAND_MEMORY_TOOLS)
  setupBrandMemory()
  setupScripts()
  setupTakes()
}
