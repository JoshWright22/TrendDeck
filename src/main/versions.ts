function parse(version: string): { core: number[]; pre: string[] } | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version)
  return match ? { core: match.slice(1, 4).map(Number), pre: match[4]?.split('.') ?? [] } : null
}

export function newer(candidate: string, installed: string): boolean {
  const left = parse(candidate)
  const right = parse(installed)
  if (!left || !right) return false
  for (let index = 0; index < 3; index++) {
    if (left.core[index] !== right.core[index]) return left.core[index] > right.core[index]
  }
  if (!left.pre.length || !right.pre.length) return !left.pre.length && right.pre.length > 0
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index++) {
    const first = left.pre[index]
    const second = right.pre[index]
    if (first === second) continue
    if (first === undefined || second === undefined) return second === undefined
    const firstNumeric = /^\d+$/.test(first)
    const secondNumeric = /^\d+$/.test(second)
    if (firstNumeric && secondNumeric) return Number(first) > Number(second)
    if (firstNumeric !== secondNumeric) return !firstNumeric
    return first > second
  }
  return false
}
