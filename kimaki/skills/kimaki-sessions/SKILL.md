---
name: kimaki-sessions
description: Run session operations in Kimaki: start a thread with `kimaki send`, reuse or fork a thread, create a worktree, schedule a routine with `--send-at`, read a past session or transcript, find who edited a file, send work to another project, and wait for a session to finish. Use when the user asks to spawn a helper session, schedule a reminder or routine, look up an old session, or when you need another session's result before continuing. Only for Kimaki Discord sessions.
---

# Session operations

The current session ID is `$OPENCODE_SESSION_ID`. The data directory is `$KIMAKI_DATA_DIR`. The Discord channel ID, thread ID and guild ID are on the per-turn `<discord-user ... />` line.

## Start a session

Start a new thread in this channel:

```bash
kimaki send --channel <channel_id> --prompt 'your prompt here' --agent <current_agent> --parent-session $OPENCODE_SESSION_ID --user <user_id>
```

Use it to spawn helper sessions that work in parallel: start threads with focused prompts, then collect the results. Rules for every new session:

- Pass `--parent-session $OPENCODE_SESSION_ID`. The child then knows this session and can message back, only when the user asks.
- Pass `--agent <current_agent>` so the child keeps the same agent. The system prompt lists the agents of this bot.
- `--user` takes a Discord user ID or a raw mention and adds that user to the thread. Repeat it for more users. Resolve a name with `kimaki user list` first.
- Quote `--prompt`, `--user` and `--send-at` with single quotes so backticks inside the prompt do not run in the shell.
- The child has no memory of this conversation. Include the details it needs, and prefer one session that investigates and acts over several narrow ones.
- A prompt over 2000 characters for another machine's channel is sent as a file attachment.

Choose the destination:

- This channel by default, unless the user asks for another place.
- Another project channel: resolve it with `kimaki project list --json` and pass that channel ID, or pass `--project /path/to/project`.
- A folder: `--project` for a project root, or `--cwd /path/to/checkout` for an existing subfolder or linked worktree of the same clone.

More flags:

```bash
# notification thread without an AI session
kimaki send --channel <channel_id> --prompt 'User cancelled subscription' --notify-only --agent <current_agent>

# attach local files; --file is repeatable
kimaki send --channel <channel_id> --prompt 'Review this screenshot' --file /path/to/screenshot.png --agent <current_agent> --parent-session $OPENCODE_SESSION_ID

# another agent, only when the user names it
kimaki send --channel <channel_id> --prompt 'Refactor the auth module' --agent <agent_name> --parent-session $OPENCODE_SESSION_ID
```

## Working directory and worktrees

OpenCode owns the session working directory. The per-turn working-directory context wins over paths in old history. A shell `cd` does not move the session.

`kimaki session cwd` prints the directory. `kimaki session cwd /path/to/directory` requests a safe move; the reply is an acknowledgement, not proof that the move finished. Move only when the user asks, and only inside the channel project or a linked worktree of the same clone.

Create a worktree only when the user explicitly asks:

```bash
kimaki send --channel <channel_id> --prompt 'Work in this checkout only' --worktree feature-name --agent <current_agent> --parent-session $OPENCODE_SESSION_ID
```

`--base-branch <ref>` sets the starting commit; the default is the committed HEAD of the mapped project. Uncommitted files are not copied. `--cwd` reuses an existing checkout and turns off worktree creation, so do not combine the two.

Worktree management:

```bash
kimaki worktree list --channel <channel_id>
kimaki worktree merge <directory> --channel <channel_id> --strategy rebase|squash
kimaki worktree remove <directory> --channel <channel_id>
```

Merge updates local branches only. Remove refuses dirty or unmerged work and keeps branch refs and session history.

## Send to an existing thread

```bash
kimaki send --thread <thread_id> --prompt 'follow-up prompt' --agent <current_agent>
```

Every command that takes a session (`--session`, `--thread`, or a positional ID) accepts a session ID, a Discord thread ID, or a Discord thread URL. Prefer the thread ID: `--thread` works from every computer, while a session ID exists only on the computer that created it.

To continue a thread from another computer, list the channel threads, then send:

```bash
kimaki project list --json
kimaki thread list --channel <channel_id> --json
kimaki send --thread <thread_id> --prompt 'continue the work' --agent <current_agent>
```

## Prompt suffixes: queue and btw

A plain message to a busy thread interrupts its run. `kimaki send` has no queue flag, so end the prompt with a suffix instead. Suffixes work in Discord messages and in `kimaki send --thread` or `--session` prompts. Put the suffix after punctuation (`.`, `!`, `?`, `,`, `;`, `:`) or on its own last line. Case does not matter. Kimaki removes the suffix before sending the prompt.

- `. queue`: wait until the current run finishes, then send the prompt to the same session.
- `. btw`: fork the session now into a new `btw:` thread with this prompt. The source session keeps running.

`. btw` needs an existing thread with a session. With `kimaki send --channel` it does not fork. The fork thread shows in a user's sidebar only when you pass `--user`.

```bash
kimaki send --thread <thread_id> --prompt 'Run the tests after your current work. queue' --agent <current_agent>
kimaki send --thread <thread_id> --prompt 'What does this error mean? btw' --agent <current_agent>
```

When you send a follow-up to a thread that may be busy, use `. queue` unless you mean to interrupt it.

## Commands and agent switch

Start `--prompt` with `/commandname` to run an OpenCode command or MCP prompt by its exact name (`/review`, `/server:prompt`). A name with no command is sent as plain text. Skills do not route this way; in Discord the user runs a skill with the `/<skill>-skill` slash command. This works for new threads and for existing threads:

```bash
kimaki send --thread <thread_id> --prompt '/review fix the auth module' --agent <current_agent>
kimaki send --channel <channel_id> --prompt '/review the last commit' --agent <current_agent> --parent-session $OPENCODE_SESSION_ID
```

The user switches the agent mid-session with the Discord slash command `/<agentname>-agent`. If you are in plan mode and the user asks for file edits, tell them to run `/build-agent` first.

## Session handoff

When the context window is nearly full, or the user asks to hand off, continue in a new thread, or start fresh, start a new session with a summary:

```bash
kimaki send --channel <channel_id> --prompt 'Continuing from previous session: <summary of current task and state>' --agent <current_agent> --parent-session $OPENCODE_SESSION_ID
```

## Schedule a routine

`--send-at` takes a one-time UTC ISO date or a cron expression:

```bash
kimaki send --channel <channel_id> --prompt 'Reminder: review open PRs' --send-at '2026-03-01T09:00:00Z' --agent <current_agent>
kimaki send --channel <channel_id> --prompt 'Run weekly test suite and summarize failures' --send-at '0 9 * * 1' --agent <current_agent> --parent-session $OPENCODE_SESSION_ID
```

All scheduling is UTC. Dates end with `Z`. Cron expressions also fire in UTC, so `0 9 * * 1` is 09:00 UTC every Monday. When the user gives a time without a timezone, ask for the timezone or the UTC equivalent. Never guess.

`--send-at` accepts these options:

- `--notify-only`: a reminder thread without an AI session. Channel targets only.
- `--agent` and `--model`: set the session of the routine.
- `--pre-run '<command>'`: Kimaki runs the command in the project directory first. Exit code 0 starts the session and appends stdout to the prompt. Any other exit code skips that run. The output goes to the Kimaki log.
- `--allow-concurrency`: runs of a routine do not overlap by default; a run is skipped while the previous session is busy. Add this only when concurrent runs are safe.
- `--parent-session`: make this session the parent of each run.
- `--user`: add a user to every run's thread. Use it for reminders, not for autonomous routines.

`--wait` and `--file` do not work with `--send-at`. Schedule a routine on the machine that owns its channel.

Keep the routine prompt short, because it becomes the first message in each thread. Write the full routine in a markdown file in the project `routines/` folder with the goal, constraints, expected output and completion criteria, then point at it:

```bash
kimaki send --channel <channel_id> --prompt 'Read routines/weekly-test-suite.md and follow instructions' --send-at '0 9 * * 1' --agent <current_agent> --parent-session $OPENCODE_SESSION_ID
```

Routine file frontmatter:

```yaml
---
title: Weekly test suite
description: >
  Managed by a kimaki routine. Do not move or delete this file
  without also updating the routine (kimaki routine list / kimaki routine edit).
---
```

For a simple reminder, inline the prompt because no AI session reads files.

Notification rules for autonomous routines:

- Do not pass `--user`. It adds the user to every thread before the result is known. Put the Discord ID in the routine file and tell the agent to mention the user only after work worth reviewing, when reporting an issue, or when asking for a decision.
- When a run finds no work and changes nothing, do not mention the user. Archive that session with `kimaki session archive`.
- Never put a raw `@username` in a routine prompt. The text shows in the thread on every run, so a mention pings every time.

Manage routines:

```bash
kimaki routine list
kimaki routine edit <id> --prompt 'new prompt' [--send-at 'new schedule'] [--pre-run 'command'] [--allow-concurrency true|false] [--user '<discord-user-id>'] [--model 'provider/model'] [--agent '<agent>']
kimaki routine run <id>
kimaki routine delete <id>
```

An empty string clears a value, for example `kimaki routine edit <id> --user ''`. Do not read SQLite or recreate a routine to change one. Sessions started by a routine carry `taskId` in their OpenCode metadata.

Never duplicate a routine to make it run more often. Edit the cron expression of the existing routine: `kimaki routine edit <id> --send-at '0 9,18 * * *'`.

Thread reminder: `--notify-only` does not work with `--thread`, so the scheduled prompt runs in the thread session:

```bash
kimaki send --thread <thread_id> --prompt 'Reminder: you asked to be reminded about this thread.' --send-at '<future_UTC_time>' --agent <current_agent> --user <user_id>
```

## Read other sessions

`kimaki session list` lists the sessions of this project. It also takes `--json`, `--project <path>`, `--all` and `--active`; `kimaki session list --help` has the rest. Each row shows the session ID, the status (`busy`, `waiting` for input, or `idle`), the title and `tokens: N`. Titles that start with `btw:` are side sessions that answer a related question in parallel, not copies of the main task.

Kimaki writes one markdown file per session to `$KIMAKI_DATA_DIR/transcripts/<session id>.md` when a run ends. It holds user messages, assistant text and short tool inputs, with no tool output and no thinking. The first lines are `# <title> (<session id>)` and `directory: <folder>`, then messages start with `## user <time>` or `## assistant <time> (<agent>, <model>)`. Search them with rg, or with `grep -r` when rg is missing:

```bash
rg -il 'auth timeout' $KIMAKI_DATA_DIR/transcripts                     # sessions that mention it; the file name is the session ID
rg -i -C3 'auth timeout' $KIMAKI_DATA_DIR/transcripts/<session id>.md  # matches with context in one session
rg -i -m3 'rate limit' $KIMAKI_DATA_DIR/transcripts                    # first 3 matches per session
rg -i 'error\s+42|panic' $KIMAKI_DATA_DIR/transcripts                  # regex
rg -i '^# .*billing' $KIMAKI_DATA_DIR/transcripts                      # titles
rg -l '^directory: /path/to/project' $KIMAKI_DATA_DIR/transcripts      # sessions of one project
rg -il 'auth timeout' $(find $KIMAKI_DATA_DIR/transcripts -name '*.md' -mtime -3)   # last 3 days
```

Sessions that Kimaki did not run (OpenCode TUI) and old sessions appear only after a sync. `kimaki session sync` takes the sessions updated in the last 14 days. `--days <n>` widens that, `--all` takes every session and is slow the first time, and `--rebuild` writes every transcript again after a format change. It skips current transcripts, so a second run is cheap.

Read a session as markdown, with logs sent to stderr:

```bash
kimaki session read <sessionId> > ./tmp/session.md 2>/dev/null
```

The dump is compressed already: no thinking, truncated tool inputs. When it is under 100 KB, read the whole file instead of grepping first. Use `--thinking` or `--verbose` only when you need the full dump.

A Discord link such as `https://discord.com/channels/<guild_id>/<thread_id>` usually points to a session thread. `session read` accepts the thread ID too, which is the last path segment:

```bash
kimaki session read <thread_id> > ./tmp/session.md 2>/dev/null
```

When the user asks you to find a session, show the Discord thread as a clickable link, not only the session ID: `https://discord.com/channels/<guild_id>/<thread_id>`. Use the current guild ID unless the session is from another guild. `kimaki session url <id>` prints the link.

## Who edited a file

```bash
kimaki session editors src/foo.ts
kimaki session editors src/foo.ts --json
```

Output is newest first. Each row holds the session ID (`ses_xxx`), the title (the Discord thread name) and the time since the last edit.

Run this before you commit a file that this session did not edit. Get the link of the original session with `kimaki session url <session_id>` and put it on the last line of the commit message as `Discord: https://discord.com/channels/<guild_id>/<thread_id>`. When that session has no Kimaki thread, use `Session: ses_xxx` instead. When this session edited the file, use the link of this thread. Split the commit by session when files come from different sessions, and do not credit another session's edits to this one.

## Other projects

When the user names another project, run `kimaki project list` to find its directory and channel ID, then read files, search code, or run commands in that directory. When it is not listed, register the root with `kimaki project add /path/to/repo`, which creates a Discord channel. Register project roots only.

`#project-name` usually means a Kimaki project channel. Resolve it with `kimaki project list --json`, which returns `channelId`, `directory` and `guildId`.

`#Some Thread Title` with spaces means a thread title, not a project channel. Search the local sessions and read the markdown. When nothing matches, list the Discord threads as shown above instead of guessing a session ID. When you do not know the project, try each entry of `kimaki project list --json`.

Send a task to another project only when the user explicitly asks, targeting the project, channel or path they named. Ask that agent to plan first: start the prompt with "Plan how to ..." so the user can review before implementation. Keep `--agent <current_agent>` and use the plan agent only when the user names it, because it cannot edit files after approval.

```bash
kimaki send --channel <channel_id> --prompt 'Plan how to update the API client to v2' --agent <current_agent>
kimaki send --project /path/to/other-repo --prompt 'Plan how to bump version to 1.2.0' --agent <current_agent>
```

## Wait for a session

`--wait` blocks until a session completes and prints its full conversation to stdout. Use it when you need another session's result before you continue, for example to fix a bug in another project first or to chain sessions where the next step needs the previous output. When the user asks you to wait for an existing session, run `kimaki session wait <session_id>` in the shell and continue from the printed markdown. Do not tell the user to run it.

For `kimaki send --wait`, `kimaki session wait`, and the loop below, set the shell tool `timeout` to 20 minutes or more, for example `timeout: 1_500_000`. The default of 2 minutes cuts long sessions off. When the timeout still fires, read the output from disk with `kimaki session read <sessionId> > ./tmp/session.md 2>/dev/null`.

```bash
kimaki send --channel <channel_id> --prompt 'Fix the auth bug' --wait --agent <current_agent>
kimaki send --thread <thread_id> --prompt 'Run the tests' --wait --agent <current_agent>
kimaki session wait <session_id>

# wait until every other in-progress session in this project finishes
until kimaki session list --active; [ $? -eq 1 ]; do sleep 5; done

# the same for another project, or --all for every project
until kimaki session list --active --project /path/to/other-project; [ $? -eq 1 ]; do sleep 5; done
```

`session list --active` exits 0 while it finds active sessions, 1 when none remain, and 64 on an error. The loop stops only on 1, so an error never looks like "no active sessions". `--active` never lists the calling session (`OPENCODE_SESSION_ID`), so the loop does not wait for itself. Sessions can start again after the loop ends, so run the check again right before each commit. `session wait` returns when the model stops responding or when the session pauses on a question, because a question does not finish on its own until the user answers.
