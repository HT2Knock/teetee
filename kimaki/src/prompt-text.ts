// Prompt display helpers that used to sit in system-prompt.ts: the attachment
// blocks, the strip of the model-only turn context and the attachment schema.
//
// They are separate because the pure reducer (through queue.ts) and the prompt
// input path need the text, not the agent manual. Keeping them apart stops a
// 500-line instruction template from entering the reducer's import graph.

import { z } from 'zod'

const PromptAttachmentSchema = z.object({ name: z.string(), path: z.string(), inline: z.boolean() })
export type PromptAttachment = z.infer<typeof PromptAttachmentSchema>

// Every attachment of the message, numbered in Discord order, so the user and the
// model can refer to "image 2". Inline ones are already in the message.
export function attachmentsBlock(attachments: readonly PromptAttachment[]): string {
  if (attachments.length === 0) return ''
  const lines = attachments.map(
    (file, index) => `${index + 1}. ${file.name}${file.inline ? ' (inline)' : ''}: ${file.path}`,
  )
  return `<attachments>\nFiles of this message in the order the user attached them, saved on disk. Read the ones not marked inline with tools.\n${lines.join('\n')}\n</attachments>\n`
}

// Prompts before numbered attachments: only the files the model could not see inline.
export function localFilesBlock(paths: readonly string[]): string {
  if (paths.length === 0) return ''
  return `<local-files>\nAttachments saved on disk. OpenCode cannot show these inline; use tools to read them.\n${paths.join('\n')}\n</local-files>\n`
}

// Prompts stored before turnContext() moved to metadata end with the block; display paths strip it.
export function stripTurnContext(text: string): string {
  return text.replace(/\n\n(<local-files>\n[\s\S]*?<\/local-files>\n)?<discord-user [^\n]*\/>$/, '')
}

export { PromptAttachmentSchema }
