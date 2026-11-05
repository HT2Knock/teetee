// Every .ts file under a directory, for the boundary tests that scan text.

import { readdir } from 'node:fs/promises'
import path from 'node:path'

export async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map((entry) => {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) return sourceFiles(full)
      return Promise.resolve(entry.name.endsWith('.ts') ? [full] : [])
    }),
  )
  return files.flat()
}
