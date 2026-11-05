// A ws text frame arrives as Buffer on Node, but the type also allows
// ArrayBuffer and Buffer[]. Decode every shape so a frame is never "[object
// Object]".
export function textFrame(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString()
  if (Array.isArray(raw)) return Buffer.concat(raw).toString()
  if (raw instanceof Uint8Array) return Buffer.from(raw).toString()
  return ''
}
