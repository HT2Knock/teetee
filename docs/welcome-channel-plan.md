---
title: Welcome Channel Onboarding Plan
description: |
  On first setup, create a "kimaki" welcome channel with a
  tutorial thread that explains how the bot works to new users.
prompt: |
  Read discord/src/cli.ts (startup flow, quick-start path,
  full-setup path, guild selection, createdChannels array),
  discord/src/config.ts (getProjectsDir), and
  discord/src/commands/create-new-project.ts (createNewProject).
  Analyzed the two startup paths and where welcome channel
  creation should hook in.
---

## Goal

When a user runs `npx kimaki` for the first time, automatically
create a **"kimaki" channel** with a **"Welcome to Kimaki"
thread** that explains how the bot works. The thread is
notify-only (no AI session starts). This gives new users an
immediate reference for channels, threads, voice, permissions,
and available commands.

## What gets created

1. A **"kimaki" project** in `~/.kimaki/projects/kimaki` (via
   `createNewProject()` from `create-new-project.ts`)
2. A **text channel** (and optionally voice) under the Kimaki
   category
3. A **tutorial message** posted in the channel
4. A **"Welcome to Kimaki" thread** on that message (notify-only,
   no AI session auto-starts)

Idempotent: if `~/.kimaki/projects/kimaki` already exists, skip
everything. Safe to call on every startup.

## Implementation plan

### 1. Add `WELCOME_TUTORIAL_MESSAGE` constant

A multi-line string covering:

- How channels map to project directories
- How threads = sessions
- Voice channels
- Permissions (owner / admin / manage server / Kimaki role)
- Key slash commands

Commands to include (current as of now):
`/add-project`, `/create-new-project`, `/model`, `/agent`,
`/new-session`, `/resume`, `/share`, `/new-worktree`, `/queue`,
`/compact`, `/verbosity`, `/abort`, `/login`,
`/toggle-mention-mode`

Place near top of `cli.ts` after imports, or in a dedicated
file if it gets long.

### 2. Add `createWelcomeChannel()` function

```
createWelcomeChannel({ guild, appId, botToken, discordClient })
```

Steps:

1. Check if `~/.kimaki/projects/kimaki` exists -> return null
2. Call `createNewProject({ guild, projectName: 'kimaki', appId })`
3. Send `WELCOME_TUTORIAL_MESSAGE` to the new text channel
4. Create a thread on that message named "Welcome to Kimaki"
   with 7-day auto-archive

For sending the message and creating the thread, two options:

- **discord.js** (`TextChannel.send()` + `startThread()`) -
  consistent with the rest of the codebase
- **raw fetch** to Discord API - avoids needing to resolve the
  channel object, simpler for a one-shot

Prefer discord.js for consistency.

### 3. Hook into startup flow

`cli.ts` has two startup paths:

**Full setup path** (first run, interactive prompts):

- Resolve `targetGuild` **before** project selection prompt
  (currently guild selection is inside the `selectedProjects`
  block at lines 1817-1845 -- hoist it earlier)
- Call `createWelcomeChannel()` before project channel creation
- Push result into `createdChannels` array so it appears in the
  ready message

**Quick-start path** (subsequent runs, non-interactive):

- Call `createWelcomeChannel()` in the background void block
  alongside channel sync and role reconciliation
- Non-blocking, uses `guilds[0]` as target guild

### 4. Hoist guild selection (full-setup path)

Move `targetGuild` resolution out of the `selectedProjects`
block so it's available for both the welcome channel and project
channel creation. Guard it so it only prompts when needed.

Quick-start path picks `guilds[0]` implicitly, no change needed.

### 5. Update comments in create-new-project.ts

Lines 2 and 19 say "reused by onboarding (welcome channel)" but
this caller didn't exist until now. Update them to reference
`createWelcomeChannel()` in `cli.ts`.

### 6. Typecheck

Run `pnpm tsc` in `discord/` to validate.

## Open questions

- **Should the tutorial be a pinned message instead of (or in
  addition to) a thread?** A pinned message is more discoverable
  since threads auto-archive after 7 days. Could do both: pin
  the starter message and also create the thread.
- **Should the welcome channel use `handleOpencodeSession` to
  have the AI greet the user?** The `/create-new-project`
  command does this ("say hi and ask what the user wants to
  build"). The welcome channel could do the same, or stay
  notify-only to avoid consuming API tokens on setup.
- **discord.js vs raw fetch for the message/thread?** discord.js
  is more consistent but requires fetching the channel object.
  Raw fetch is simpler for a fire-and-forget setup step.
