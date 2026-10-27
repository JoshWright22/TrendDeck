import type { CraftDock } from '@shared/craft'

interface Target {
  priority: number
  dock: CraftDock
}

export class DockTargets {
  private targets = new Map<symbol, Target>()
  private sent = new Map<string, string>()

  constructor(private send: (dock: CraftDock) => void) {}

  set(id: symbol, dock: CraftDock, priority: number): void {
    this.targets.set(id, { dock, priority })
    this.update(dock.appId)
  }

  remove(id: symbol): void {
    const target = this.targets.get(id)
    this.targets.delete(id)
    if (target) this.update(target.dock.appId)
  }

  private update(appId: string): void {
    const target = [...this.targets.values()]
      .filter((entry) => entry.dock.appId === appId)
      .sort((left, right) => right.priority - left.priority)[0]
    const dock = target?.dock ?? { appId, bounds: null, visible: false }
    const line = JSON.stringify(dock)
    if (this.sent.get(appId) === line) return
    this.sent.set(appId, line)
    this.send(dock)
  }
}

export function containedBy(
  inner: { left: number; top: number; right: number; bottom: number },
  outer: { left: number; top: number; right: number; bottom: number }
): boolean {
  return inner.left >= outer.left && inner.top >= outer.top && inner.right <= outer.right && inner.bottom <= outer.bottom
}
