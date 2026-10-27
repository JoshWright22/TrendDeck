// an error as the user should read it: electron wraps errors thrown in main as
// "Error invoking remote method 'x': Error: message", this keeps only the message
export function cleanError(err: unknown, fallback?: string): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const message = raw.replace(/^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/, '').trim()
  if (message) return message
  return fallback ?? (err instanceof Error || typeof err === 'string' ? raw : String(err))
}
