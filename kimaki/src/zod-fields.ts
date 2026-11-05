// The zod field shapes the RPC schemas share. A rule that lives in two
// schemas drifts: this is the one place for "a non-empty string".
//
// Values only, no schemas: each route composes its own object.

import { z } from 'zod'

export function text(key: string) {
  const message = `${key} must be a non-empty string`
  return z.string({ error: message }).refine((value) => value.trim() !== '', { error: message })
}
