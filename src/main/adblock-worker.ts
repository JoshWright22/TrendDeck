import { parentPort } from 'node:worker_threads'
import { ElectronBlocker } from '@ghostery/adblocker-electron'

// parsing every list takes a few seconds, so it happens here and not on the main thread
parentPort?.once('message', (msg: { lists: string[]; resources: string }) => {
  try {
    const engine = ElectronBlocker.parse(msg.lists.join('\n'), {
      loadNetworkFilters: true,
      loadCosmeticFilters: true,
      loadCSPFilters: true,
      loadExceptionFilters: true,
      loadGenericCosmeticsFilters: true,
      enableMutationObserver: true
    })
    if (msg.resources) engine.updateResources(msg.resources, String(msg.resources.length))
    const out = engine.serialize()
    parentPort?.postMessage({ ok: true, engine: out }, [out.buffer as ArrayBuffer])
  } catch (err) {
    parentPort?.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
})
