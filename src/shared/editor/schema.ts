// a small JSON schema builder and checker. command params are written once with these helpers,
// published as plain JSON schema to agents, and checked before any command runs

export interface JsonSchema {
  type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'null'
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: boolean
  items?: JsonSchema
  enum?: (string | number)[]
  minimum?: number
  maximum?: number
  minItems?: number
  anyOf?: JsonSchema[]
  default?: unknown
}

type Props = Record<string, JsonSchema & { optional?: boolean }>

export const s = {
  object(props: Props, description?: string): JsonSchema {
    const properties: Record<string, JsonSchema> = {}
    const required: string[] = []
    for (const [k, v] of Object.entries(props)) {
      const { optional, ...rest } = v
      properties[k] = rest
      if (!optional) required.push(k)
    }
    return { type: 'object', description, properties, required, additionalProperties: false }
  },
  string: (description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({ type: 'string', description, ...extra }),
  number: (description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({ type: 'number', description, ...extra }),
  integer: (description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({ type: 'integer', description, ...extra }),
  boolean: (description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({ type: 'boolean', description, ...extra }),
  enum: (values: string[], description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({ type: 'string', enum: values, description, ...extra }),
  array: (items: JsonSchema, description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({ type: 'array', items, description, ...extra }),
  any: (description: string): JsonSchema => ({ description }),
  // anything toTicks accepts
  time(description: string): JsonSchema {
    return {
      description: `${description} Seconds as a number, "1.5s", "90f" (frames), "00:00:03:12" (timecode), or {seconds}|{frames}|{timecode}|{ticks}.`,
      anyOf: [
        { type: 'number' },
        { type: 'string' },
        {
          type: 'object',
          properties: {
            seconds: { type: 'number' },
            frames: { type: 'integer' },
            timecode: { type: 'string' },
            ticks: { type: 'integer' }
          }
        }
      ]
    }
  },
  optional<T extends JsonSchema>(schema: T): T & { optional: true } {
    return { ...schema, optional: true }
  }
}

function typeOf(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

// returns the first problem found, or null when the value fits
export function validate(schema: JsonSchema, v: unknown, path = 'args'): string | null {
  if (schema.anyOf) {
    for (const alt of schema.anyOf) if (validate(alt, v, path) === null) return null
    return `${path} doesn't match any allowed form`
  }
  if (schema.enum && !schema.enum.includes(v as string | number)) return `${path} must be one of ${schema.enum.join(', ')}`
  switch (schema.type) {
    case undefined:
      return null
    case 'object': {
      if (typeOf(v) !== 'object') return `${path} must be an object`
      const o = v as Record<string, unknown>
      for (const k of schema.required ?? []) if (o[k] === undefined) return `${path}.${k} is required`
      for (const [k, val] of Object.entries(o)) {
        const sub = schema.properties?.[k]
        if (!sub) {
          if (schema.additionalProperties === false) return `${path}.${k} is not a known field`
          continue
        }
        if (val === undefined) continue
        const err = validate(sub, val, `${path}.${k}`)
        if (err) return err
      }
      return null
    }
    case 'array': {
      if (!Array.isArray(v)) return `${path} must be an array`
      if (schema.minItems !== undefined && v.length < schema.minItems) return `${path} needs at least ${schema.minItems} entries`
      if (schema.items) {
        for (let i = 0; i < v.length; i++) {
          const err = validate(schema.items, v[i], `${path}[${i}]`)
          if (err) return err
        }
      }
      return null
    }
    case 'integer':
    case 'number': {
      if (typeof v !== 'number' || !Number.isFinite(v)) return `${path} must be a number`
      if (schema.type === 'integer' && !Number.isInteger(v)) return `${path} must be a whole number`
      if (schema.minimum !== undefined && v < schema.minimum) return `${path} must be at least ${schema.minimum}`
      if (schema.maximum !== undefined && v > schema.maximum) return `${path} must be at most ${schema.maximum}`
      return null
    }
    case 'string':
      return typeof v === 'string' ? null : `${path} must be a string`
    case 'boolean':
      return typeof v === 'boolean' ? null : `${path} must be true or false`
    case 'null':
      return v === null ? null : `${path} must be null`
  }
}
