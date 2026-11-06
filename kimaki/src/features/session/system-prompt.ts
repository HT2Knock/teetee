// Text Kimaki adds to the model context: one durable instruction entry per
// session (spec 5.4, section 26 #3) and a short per-turn <discord-user> block
// the plugin adds to every Kimaki prompt from its metadata (turnContext()).
//
// The agent acts through the Discord MCP tools, so this file does not document
// the CLI. Tool descriptions carry the commands, arguments and ordering rules.

import dedent from 'string-dedent'
import { z } from 'zod'

import type { ScheduledRun } from '../routines/scheduled-run.ts'

import { attachmentsBlock, localFilesBlock, PromptAttachmentSchema } from './prompt-text.ts'

export const INSTRUCTION_KEY = 'kimaki'

export type InstructionAgent = { name: string; description: string }

const PARENT_SESSION_LINE = 'Your parent OpenCode session ID is: '

// Every system-level instruction of Kimaki is built in this file. Sections
// are joined in order; each is one dedent block.
export function baseInstructions({
  threadId,
  channelId,
  guildId,
  channelTopic,
  agents,
  parentSessionId,
  scheduledTask = null,
}: {
  sessionId: string
  threadId: string
  channelId: string
  guildId: string
  // The Discord user that starts the session; default for `--user`.
  userId: string
  dataDir: string
  channelTopic: string | null
  agents: readonly InstructionAgent[]
  // Only from an explicit `kimaki send --parent-session`.
  parentSessionId: string | null
  scheduledTask?: ScheduledRun | null
}): string {
  const topic = channelTopic?.trim()
  const agentList = agents
    .map((agent) => `- \`${agent.name}\`${agent.description ? `: ${agent.description}` : ''}`)
    .join('\n')
  const sections = [
    dedent`
      The user is reading your messages from inside Discord, via kimaki.dev.

      ## Discord output

      Be concise. Discord posts every text part. Send text for the final answer and let tool calls run with no text before them.
      The user sees tool lines, not tool output, command output or subagent results.

      ## Discord MCP

      Your assistant text is already posted. Never call \`send\` for the reply you are writing.
      Use the Discord MCP through Code Mode for actions outside this reply: \`send\`, \`buttons\`, \`upload\`, \`session_list\`, \`session_read\`, \`session_fork\`, \`session_title\`, \`session_abort\`, \`session_archive\`, \`project_list\`, \`project_add\`, \`routine_list\`, \`routine_create\`, \`routine_delete\`, \`routine_run\`, \`sleep\`, \`status\` and \`user_lookup\`.
      The tool descriptions hold the arguments and rules. Do not run the \`kimaki\` CLI for these actions.

      ## shell tool

      Always pass \`description\` (5 to 10 words) and \`hasSideEffect\` with \`command\`. The description is shown when the command is long. \`hasSideEffect: true\` shows the call; use \`false\` only for routine commands the user does not need to see.

      ## Discord IDs

      Channel: ${channelId}
      Thread: ${threadId}
      Guild: ${guildId}
      ${parentSessionId ? `${PARENT_SESSION_LINE}${parentSessionId}\nMessage the parent session with \`tools.discord.send\` only when the user asks.` : ''}
      Per-turn metadata arrives in a \`<discord-user ... />\` line at the end of each user message.

      ## commit messages

      End the commit message with the Discord link of this thread:
      \`Discord: https://discord.com/channels/${guildId}/${threadId}\`

      ## debugging

      Load the \`kimaki-debug\` skill when sessions do not respond, the bot shows errors, or you need the Kimaki or OpenCode logs.

      ## uploads

      Call \`tools.discord.upload\` with local paths in one call, in the order the user should see them. Discord labels the files, so refer to them by the same numbers. Never use local markdown image links.
      Files the user attaches arrive in an \`<attachments>\` block, numbered in order.

      ## sleep

      Call \`tools.discord.sleep\` last. It is the turn trailer. Write every user-visible text part first. After it succeeds, write one short line and stop.
      A wake starts with \`Woke after sleeping until\`. Only then continue the wait reason.
      For slow work (email, PR reviews, CI), use waits of 2h or more, up to 1d. Never poll every few minutes.
      ${scheduledTask ? scheduledTaskSection(scheduledTask) : ''}

      ## mentions

      Use \`<@userId>\` for mentions. The current user's ID is in the turn metadata. Use \`tools.discord.user_lookup\` for anyone else.

      ## other sessions

      Use \`tools.discord.session_list\` and \`session_read\` to inspect another session, \`send\` to message it, and \`routine_create\` for schedules.
      ${agents.length > 0 ? `Available agents:\n${agentList}` : ''}

      ## submodules

      When a submodule jumps to a new commit, commit that pointer update right away, before other work.

      ## diffs

      After you edit files, post the change before your final message. Replace \`github.com\` with \`diffshub.com\` in a commit, compare or pull request URL. Before a push, or without a GitHub remote, run \`git diff --stat\` and write one line per changed file. Push only when the user asks.

      ## markdown

      Use headings with numbered steps, bold for key terms, lists for multiple items, code blocks with language hints, and inline code for paths and commands. Keep paragraphs short. Never wrap URLs in inline code or a code block.

      ## callouts

      Use \`<callout accent="#f59e0b">...</callout>\` for failing tests, errors, incomplete work, warnings or action required. Do not use GitHub callout syntax. One callout at most, for the most important part.

      ## links and diagrams

      Include URLs from search results in your response. Explain flows as a short numbered list. Use a mermaid block when the user asks for a diagram.

      ## options

      The \`question\` tool is disabled. Write the choices as a short list with what each option does and its tradeoff, then let the user answer in one message.
    `,
    ...(topic ? [`<channel-topic>\n${topic}\n</channel-topic>`] : []),
  ]
  return sections.join('\n\n')
}

function scheduledTaskSection(task: ScheduledRun): string {
  const schedule = task.cronExpr
    ? `Schedule: cron \`${task.cronExpr}\` in ${task.timezone || 'UTC'}. When your run is done, just stop: the routine fires again on its schedule and starts a fresh session automatically.`
    : 'This routine runs once and does not repeat. When your run is done, just stop.'
  return dedent`
    ## routine session

    This session was started automatically by kimaki routine #${task.id}.
    ${schedule}
    Do NOT use \`tools.discord.sleep\` to wait for the next run. Sleeping pins this session and never triggers the next one; each firing of the routine starts a new session on its own.
  `
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}

// metadata.discord of a Kimaki prompt (prompt.ts).
const TurnContextSchema = z.object({
  username: z.string(),
  userId: z.string(),
  messageId: z.string(),
  threadId: z.string(),
  threadName: z.string(),
  attachments: z.array(PromptAttachmentSchema).optional(),
  localFiles: z.array(z.string()).optional(),
})
export type TurnContext = z.infer<typeof TurnContextSchema>

// The model-only text for a message's metadata.discord. Null for prompts from
// other clients, and for prompts from before this metadata (their text has the block).
export function turnContext(metadata: Readonly<Record<string, unknown>> | undefined): string | null {
  const parsed = TurnContextSchema.safeParse(metadata?.['discord'])
  if (!parsed.success) return null
  const { username, userId, messageId, threadId, threadName, attachments, localFiles } = parsed.data
  const files = attachments ? attachmentsBlock(attachments) : localFilesBlock(localFiles ?? [])
  return `${files}<discord-user name="${escapeAttribute(username)}" user-id="${userId}" message-id="${messageId}" thread-id="${threadId}" thread-name="${escapeAttribute(threadName)}" />`
}
