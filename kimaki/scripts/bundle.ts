// Bundles the CLI entry into dist/cli.js with code splitting, on top of the tsc output.
//
// tsc still writes dist/ module by module, because the OpenCode plugin shim loads
// <package>/dist/plugin/<dir>/index.js as plain ESM. The bundle only replaces the
// CLI entry and adds content-hashed chunks next to it, so every `import.meta.url`
// in the CLI graph still resolves to <package>/dist/<file>.js and finds the
// package root two levels up.
//
// Splitting keeps the lazy `await import()` stacks (discord.js, voice, tunnel) out
// of the entry chunk. Without it they are inlined and evaluated on every run,
// which made `kimaki --help` slower than the unbundled build (200 ms vs 96 ms).

import fs from 'node:fs/promises'
import path from 'node:path'

const outdir = 'dist'
const manifestPath = path.join(outdir, '.bundle-files.json')

const result = await Bun.build({
  entrypoints: ['src/cli.ts'],
  outdir,
  target: 'bun',
  splitting: true,
  sourcemap: 'external',
  naming: { entry: '[name].[ext]', chunk: '[name]-[hash].[ext]', asset: '[name]-[hash].[ext]' },
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

const written = result.outputs.map((output) => path.relative(outdir, output.path)).sort()

// Hash names change whenever a chunk changes, so delete the chunks of the
// previous build instead of letting them pile up in dist.
const previous: string[] = await fs
  .readFile(manifestPath, 'utf8')
  .then((text) => JSON.parse(text) as string[])
  .catch(() => [])
const stale = previous.filter((file) => !written.includes(file))
await Promise.all(stale.map((file) => fs.rm(path.join(outdir, file), { force: true })))
await fs.writeFile(manifestPath, `${JSON.stringify(written, null, 2)}\n`)

const entry = result.outputs.find((output) => output.path.endsWith('/cli.js'))
const size = entry ? `, entry ${Math.round(Number(entry.size) / 1024)} kB` : ''
console.log(`bundled dist/cli.js: ${written.length} files${size}, ${stale.length} stale removed`)
