// Reading another app's SQLite file without touching it.
//
// bun:sqlite ignores `file:` URI filenames in ATTACH DATABASE (it treats them
// as literal paths, so `file:/x?mode=ro` fails with SQLITE_CANTOPEN), and
// opening a WAL database read-write can checkpoint its -wal on close. Both
// problems go away if the read happens on a throwaway copy: copy the file and
// its -wal and -shm siblings into a temp folder, then open the copy.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Runs `read` on a private copy of `file` and deletes the copy afterwards.
// The copy keeps the file name, so relative references inside it still match.
//
// The -shm file is deliberately not copied: it is a rebuildable index, and
// copying it while a writer updates the WAL produces a copy SQLite refuses to
// open ("bad parameter or other API misuse"). The copy replays the WAL on open.
export function withSqliteCopy<T>({ file, read }: { file: string; read: (copy: string) => T }): T {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-sqlite-copy-'))
  const copy = path.join(directory, path.basename(file))
  try {
    for (const suffix of ['', '-wal']) {
      if (fs.existsSync(`${file}${suffix}`)) fs.copyFileSync(`${file}${suffix}`, `${copy}${suffix}`)
    }
    return read(copy)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}
