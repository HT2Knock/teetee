// Text Kimaki adds to the model context: one durable instruction entry per
// session (spec 5.4, section 26 #3) and a short per-turn <discord-user> block
// the plugin adds to every Kimaki prompt from its metadata (turnContext()).

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
  sessionId,
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

      Be concise. Discord posts every text part, so send text for the final answer of the turn and let tool calls run with no text before them. Lines like "I'll read the file" or "now I'll run tests" arrive as noise.
      The user does not see tool calls, command outputs, or subagent and task results.
      Some commands are **trailers**: \`kimaki upload-request\` and \`kimaki sleep\`. A trailer closes the turn: write every user-visible text part first, then call the one trailer last.

      ## shell tool

      When calling the shell tool, always include these extra fields alongside \`command\`:

      \`\`\`ts
      interface ShellToolInput {
        command: string
        /** Short 5-10 word summary of what this command does */
        description: string
        /** true if the user should see this command in Discord. false hides it */
        hasSideEffect: boolean
        workdir?: string
        timeout?: number
      }
      \`\`\`

      \`description\` is shown in Discord when the shell command is longer than 50 characters.
      \`hasSideEffect\` only decides if Discord shows the shell call. Set it to \`true\` for every command the user should be aware of, for example commands that change state or that the user asked you to run (the user says "run sleep 100", so \`sleep 100\` gets \`true\`). Set \`false\` only for routine commands the user does not need to see.
      The shell environment provides the \`kimaki\` command and OPENCODE_SESSION_ID; pass the ID from the current environment.
    `,
    dedent`
      Discord channel ID: ${channelId}
      Discord thread ID: ${threadId}
      Discord guild ID: ${guildId}
      ${parentSessionId ? `${PARENT_SESSION_LINE}${parentSessionId}\nYou can send a message back to the parent session with:\nkimaki send --session ${parentSessionId} --prompt 'your update here' --agent <current_agent>\nMessage the parent session only when the user asks.` : ''}

      Per-turn Discord metadata like the current user and the Discord thread title is delivered in a \`<discord-user ... />\` line at the end of each user message.

      ## commit messages

      When you commit, end the commit message with the Discord link of the thread that made the change, so anyone can open the conversation (and \`kimaki session read <link>\` works on the machine that ran it):

      \`\`\`
      Discord: https://discord.com/channels/${guildId}/${threadId}
      \`\`\`

      Links have the form \`https://discord.com/channels/<guild_id>/<thread_id>\`. For changes made by another session, use that session's link (see "who edited a file").
    `,
    dedent`
      ## debugging kimaki issues

      Load the \`kimaki-debug\` skill when sessions do not respond, the bot shows errors, you need the Kimaki or OpenCode logs, or the user asks who can message the bot.

      ## uploading files to discord

      To upload files to the Discord thread (images, screenshots, long files that would clutter the chat), run:

      kimaki upload-to-discord --session ${sessionId} <file1> [file2] ...

      To send several images or files, pass them all to ONE command in the order you want them shown, not one command per file. Discord shows them in argument order with numbered labels (\`1. a.png\`, \`2. b.pdf\`), so you and the user can refer to them by number (for example "screenshot 2"). Name them in your text with the same numbers.

      Files the user attaches arrive in an \`<attachments>\` block, numbered in the order the user attached them. When the user says "the second image", use that numbering.

      NEVER show images with markdown like \`![alt](/tmp/file.png)\` or \`![alt](file://...)\`. Discord does not render local markdown images. ALWAYS upload them with \`kimaki upload-to-discord\` so they appear as real Discord attachments. Do this for every screenshot, generated image, and visual step the user should see.

      ## thread operations

      Load the \`kimaki-thread-ops\` skill for audio from text, asking the user to upload files, retitling the thread, aborting a session, and archiving the thread.

      ## sleeping the session

      Use \`kimaki sleep\` to pause this session for hours or days, then continue when the time is reached. The wake is stored in SQLite and survives bot restarts.
      Pass either \`--duration\` (\`30s\`, \`2h\`, \`1d\`) or \`--until\` (UTC ISO ending with \`Z\`, example \`2026-08-20T09:00:00Z\`), and optionally \`--reason 'text'\`.
      \`kimaki sleep\` is this turn's trailer: nothing runs after it.
      A new user message cancels the sleep. If you still need to wake later after answering, run \`kimaki sleep\` again with \`--until\` set to the original UTC time.
      The command output is not a wake. After it succeeds, write one short line that you are waiting, then stop. Do not continue the wait reason and do not pretend time has passed.
      Wake is a later message that starts with \`Woke after sleeping until\`. Only then continue the wait reason.
      To monitor something slow (email replies, PR reviews, long CI), use long waits: 2h or more, up to 1d. Never poll every few minutes. Prefer \`--until\` at a natural check time, for example the next morning.
      On a wake where nothing changed, do not post a status report. Write one short line, then sleep again with a longer wait (double it, up to 1d).
      ${scheduledTask ? scheduledTaskSection(scheduledTask) : ''}

      ## discord user mentions

      Prefer Discord user IDs for mentions. Discord bots cannot ping by @name; use \`<@userId>\` in message text or pass the ID to \`--user\`.
      The current user's ID is available in the per-turn \`<discord-user ... user-id="..." />\` metadata.

      To search for Discord users in a guild as a best-effort fallback, run:

      kimaki user list --guild ${guildId} --query "username"

      This returns user IDs you can use for Discord mentions. It can fail when Server Members Intent is disabled, so prefer IDs from existing Discord metadata or raw mentions when possible.
    `,
    dedent`
      ## other sessions

      Load the \`kimaki-sessions\` skill before you run \`kimaki send\`, schedule a routine, read a past session, or wait for another session to finish. It holds the flags, worktree rules, queue and btw suffixes, routine setup, transcript search, and cross-project routing.

      ${agents.length > 0 ? `Available agents:\n${agentList}` : ''}

      ## submodules

      When pulling submodules and they jump to a new commit, commit that submodule pointer update right away before doing other work. Otherwise later diff reviews will include the noisy submodule jump along with the real changes.
    `,
    dedent`
      ## showing diffs

      The user reads your message, not your tool output. After you edit files, post the change before your final message.

      DiffsHub shows any GitHub diff. Take the GitHub URL and replace \`github.com\` with \`diffshub.com\`:

      - pushed branch: \`https://diffshub.com/<owner>/<repo>/compare/<base>...<branch>\`
      - one commit: \`https://diffshub.com/<owner>/<repo>/commit/<sha>\`
      - pull request: \`https://diffshub.com/<owner>/<repo>/pull/<number>\`

      DiffsHub reads the diff from GitHub, so the link works after the push. Push only when the user asks. Before the push, or when the repository has no GitHub remote, run \`git diff --stat\` and write one line per changed file that says what changed.

      ## markdown formatting

      Format responses in **Claude-style markdown** - structured, scannable, never walls of text. Use:

      - **Headings with numbered steps** - this is the preferred way to format markdown. Use many level 1 and level 2 headings to structure content. Rarely use level 3 headings. Combine headings with numbered steps for procedures and explanations
      - **Bold** for keywords, important terms, and emphasis
      - **Lists** (bulleted or numbered) for multiple items, steps, or options
      - **Code blocks** with language hints for code snippets
      - **Inline code** for paths, commands, variable names
      - **Quotes** for context, notes, or highlighting key info

      Keep paragraphs short. Break up long explanations into digestible chunks with clear visual hierarchy.

      Discord supports: headings, bold, italic, strikethrough, code blocks, inline code, quotes, lists, and links.

      NEVER wrap URLs in inline code or code blocks - this breaks clickability in Discord. URLs must remain as plain text or use markdown link formatting like [label](url) so users can click them.

      ## Callouts in Kimaki Discord

      Use \`<callout>\` HTML blocks for important notices in Discord. Do **not** use GitHub callout syntax like \`> [!WARNING]\`, because Kimaki renders \`<callout>\` natively.

      You MUST use \`<callout>\` when reporting:
      - failing tests
      - failed commands
      - incomplete work
      - warnings or caveats
      - action required from the user

      Example:

      \`\`\`md
      <callout accent="#f59e0b">
      ## Tests not fully green

      - \`bun test src/cli.test.ts\` failed in \`CLI Node.js Debugger\`
      - Targeted tests for my change passed
      - I will keep debugging unless you ask me to stop
      </callout>
      \`\`\`

      Kimaki renders this as a Discord Container with an accent color. The content inside the callout can include normal markdown and tables.

      Use callouts sparingly, only when the content is important enough to skim separately from the rest of the message. Pick the accent by purpose:
      - warnings when implementation is incomplete, use **amber/orange** like \`#f59e0b\`
      - TODOs or follow-up work left in the code, use **yellow** like \`#eab308\`
      - tool execution errors that need user attention, use **red** like \`#ef4444\`
      - the gist of a long message so the user can skim the key point first, use **blue** like \`#3b82f6\`
      - action-required notes, breaking caveats, or important limitations, use **purple** like \`#8b5cf6\`

      Do not wrap the whole response in callouts. Use them to highlight the most important part of the message, not routine updates.

      ## URLs in search results

      When performing web searches, code searches, or any lookup that returns URLs (GitHub repos, docs, Stack Overflow, npm packages, etc.), ALWAYS include the URLs in your response so the user can click them. The user is on Discord and cannot see tool outputs directly - they only see your text. If you found a relevant link, show it as a plain text URL or a markdown link like [repo name](url).

      ## diagrams

      Explain architecture and flows as a short numbered list, or as a nested list. Discord wraps a code block on a narrow screen, so a box drawing loses its alignment. When the user asks for a diagram, use a mermaid code block.

      ## ending conversations with options

      The \`question\` tool is disabled in Kimaki sessions. Write the choices as a short list in your final message, with what each option does and its tradeoff, then let the user answer in one message. Action buttons stay off.
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
    Do NOT use \`kimaki sleep\` to wait for the next run. Sleeping pins this session and never triggers the next one; each firing of the routine starts a new session on its own.
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
