// Files of a prompt, split into the ones OpenCode can inline and the ones the
// model gets as local paths. Shared by prompt.ts (sent to an existing session)
// and input.ts (first input of a new session).

import fs from 'node:fs'
import path from 'node:path'

import type { PromptFile } from './bot.ts'
import { promptFilePath } from './remote-send.ts'
import type { PromptAttachment } from './system-prompt.ts'

// OpenCode V2 shows the model only png/jpeg/gif/webp images, PDFs and text
// files; it drops other files silently, and one file over 20 MB fails the
// whole prompt (core/src/session/prompt.ts, session/runner/to-llm-message.ts).
// Those go to the model as local paths instead.
const OPENCODE_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
const INLINE_MEDIA_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf'])

// `attachments` keeps every file in the user's order, so "the second image" resolves.
export async function splitPromptFiles(files: readonly PromptFile[]) {
  const attached: Array<{ uri: string; name: string }> = []
  const attachments: PromptAttachment[] = []
  for (const file of files) {
    const local = promptFilePath(file)
    const stat = await fs.promises.stat(local).catch(() => null)
    const tooBig = stat !== null && stat.size > OPENCODE_MAX_ATTACHMENT_BYTES
    if (!tooBig) attached.push({ uri: file.uri, name: file.name })
    // Text files count as not inline: the extension cannot tell text from binary.
    attachments.push({ name: file.name, path: local, inline: !tooBig && INLINE_MEDIA_EXTENSIONS.has(path.extname(file.name).toLowerCase()) })
  }
  return { attached, attachments }
}

