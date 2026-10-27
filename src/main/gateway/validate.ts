// strict argument checks for agent tool calls. a small json schema subset, enough for every
// tool here. pure, no electron, so scripts/gateway-test.ts can run it on its own

export interface JsonSchema {
  type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array'
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  // false: no other keys. a schema: every other key has to match it
  additionalProperties?: boolean | JsonSchema
  enum?: readonly (string | number)[]
  items?: JsonSchema
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  minItems?: number
  maxItems?: number
}

export type Validated = { ok: true; value: Record<string, unknown> } | { ok: false; errors: string[] }

const typeName = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)

function check(schema: JsonSchema, v: unknown, path: string, errors: string[]): void {
  const at = path || 'arguments'
  switch (schema.type) {
    case 'string':
      if (typeof v !== 'string') {
        errors.push(`${at} should be a string, got ${typeName(v)}`)
        return
      }
      if (schema.minLength !== undefined && v.length < schema.minLength) {
        errors.push(schema.minLength === 1 ? `${at} can't be empty` : `${at} needs at least ${schema.minLength} characters`)
      }
      if (schema.maxLength !== undefined && v.length > schema.maxLength) errors.push(`${at} is longer than ${schema.maxLength} characters`)
      break
    case 'number':
    case 'integer':
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        errors.push(`${at} should be a number, got ${typeName(v)}`)
        return
      }
      if (schema.type === 'integer' && !Number.isInteger(v)) errors.push(`${at} should be a whole number`)
      if (schema.minimum !== undefined && v < schema.minimum) errors.push(`${at} should be at least ${schema.minimum}`)
      if (schema.maximum !== undefined && v > schema.maximum) errors.push(`${at} should be at most ${schema.maximum}`)
      break
    case 'boolean':
      if (typeof v !== 'boolean') errors.push(`${at} should be true or false, got ${typeName(v)}`)
      return
    case 'array': {
      if (!Array.isArray(v)) {
        errors.push(`${at} should be an array, got ${typeName(v)}`)
        return
      }
      if (schema.minItems !== undefined && v.length < schema.minItems) errors.push(`${at} needs at least ${schema.minItems} items`)
      if (schema.maxItems !== undefined && v.length > schema.maxItems) errors.push(`${at} takes at most ${schema.maxItems} items`)
      if (schema.items) v.forEach((item, i) => check(schema.items!, item, `${at}[${i}]`, errors))
      break
    }
    case 'object': {
      if (!v || typeof v !== 'object' || Array.isArray(v)) {
        errors.push(`${at} should be an object, got ${typeName(v)}`)
        return
      }
      const obj = v as Record<string, unknown>
      const props = schema.properties ?? {}
      const names = Object.keys(props)
      for (const key of Object.keys(obj)) {
        if (key in props) continue
        const extra = schema.additionalProperties
        if (extra && typeof extra === 'object') {
          check(extra, obj[key], path ? `${path}.${key}` : key, errors)
          continue
        }
        if (extra === true) continue
        const where = path ? ` in ${path}` : ''
        errors.push(
          names.length
            ? `unknown argument "${key}"${where}. accepted: ${names.join(', ')}`
            : `unknown argument "${key}"${where}, it takes no arguments`
        )
      }
      for (const key of schema.required ?? []) {
        if (obj[key] === undefined || obj[key] === null) errors.push(`${path ? `${path}.` : ''}${key} is required`)
      }
      for (const [key, sub] of Object.entries(props)) {
        // null counts as left out, agents send it for optional args a lot
        if (obj[key] === undefined || obj[key] === null) continue
        check(sub, obj[key], path ? `${path}.${key}` : key, errors)
      }
      break
    }
  }
  if (schema.enum && !schema.enum.includes(v as string | number)) {
    errors.push(`${at} should be one of ${schema.enum.join(', ')}`)
  }
}

// args come straight from the agent. missing means {}, nulls are dropped, nothing is coerced
export function validateArgs(schema: JsonSchema, raw: unknown): Validated {
  const args = raw === undefined || raw === null ? {} : raw
  const errors: string[] = []
  check({ ...schema, type: 'object' }, args, '', errors)
  if (errors.length) return { ok: false, errors }
  const value: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) if (v !== null && v !== undefined) value[k] = v
  return { ok: true, value }
}

// schema helpers for tool definitions
export const obj = (properties: Record<string, JsonSchema> = {}, required: string[] = []): JsonSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false
})
export const str = (description: string, maxLength?: number, minLength?: number): JsonSchema => ({
  type: 'string',
  description,
  ...(maxLength !== undefined ? { maxLength } : {}),
  ...(minLength !== undefined ? { minLength } : {})
})
export const num = (description: string, minimum?: number, maximum?: number): JsonSchema => ({
  type: 'number',
  description,
  ...(minimum !== undefined ? { minimum } : {}),
  ...(maximum !== undefined ? { maximum } : {})
})
export const int = (description: string, minimum?: number, maximum?: number): JsonSchema => ({
  ...num(description, minimum, maximum),
  type: 'integer'
})
export const bool = (description: string): JsonSchema => ({ type: 'boolean', description })
export const oneOf = (description: string, values: readonly string[]): JsonSchema => ({ type: 'string', description, enum: values })
export const list = (description: string, items: JsonSchema, maxItems?: number, minItems?: number): JsonSchema => ({
  type: 'array',
  description,
  items,
  ...(maxItems !== undefined ? { maxItems } : {}),
  ...(minItems !== undefined ? { minItems } : {})
})
