---
name: kimaki-thread-ops
description: Run the rare thread and session operations in Discord: audio from text with `kimaki tts`, asking the user to upload files with `kimaki upload-request`, retitling with `kimaki session title`, aborting a session you started with the wrong prompt, and archiving the thread. Use when the user asks for audio, when you need a file from the user, when the scope of the thread changed, when a prompt went to the wrong session, or when the user asks to close the thread. Only for Kimaki Discord sessions.
---

# Thread operations

The current session ID is `$OPENCODE_SESSION_ID` in the shell. The Discord thread ID is on the per-turn `<discord-user ... />` line.

## Audio from text

When the user asks for audio of some text so they can listen instead of reading, write a speech file with `kimaki tts`, then send it with `kimaki upload-to-discord --session $OPENCODE_SESSION_ID`. `kimaki tts` prints the path it wrote, and `kimaki tts --help` lists voice, speed, and style options.

```bash
# from inline text
kimaki tts 'Your summary goes here' -o /tmp/summary.mp3
kimaki upload-to-discord --session $OPENCODE_SESSION_ID /tmp/summary.mp3

# from a file, piped via stdin
cat docs/explanation.md | kimaki tts -o /tmp/explanation.mp3
kimaki upload-to-discord --session $OPENCODE_SESSION_ID /tmp/explanation.mp3
```

## Ask the user to upload files

Write all visible text first, then run `kimaki upload-request --prompt 'Send the files' --max-files 5` with the shell timeout set to 600000 ms. This shows a native file picker in Discord. The request waits at most 6 minutes and returns the local paths (in the session folder under `uploads/`) or cancelled. A new user prompt cancels the request, so stop waiting then. It is this turn's trailer.

## Retitle the thread

Skip the first turn: OpenCode auto-generates the title from the first message. A btw fork keeps the parent title, so rename it when its own prompt asks for one. On a later turn, retitle when the scope or goal changed:

```bash
kimaki session title 'Short title' --session $OPENCODE_SESSION_ID
```

The current Discord title is on the `<discord-user thread-name="..." />` line, and Discord follows the OpenCode title. Discord rate-limits thread renames, so retitle once per real change. Keep titles short, with no emoji and no `⬦`, `btw:`, or `Fork:` prefixes.

## Abort a session

After sending a prompt to the wrong place, with the wrong text, or through a mangled heredoc, abort that session immediately with the session ID printed in the command output:

```bash
kimaki session abort <session_id>
```

This stops the AI from processing and keeps the thread visible in Discord. `kimaki session archive` is different: it hides the thread.

## Archive the thread

To hide the current thread from the sidebar without stopping the session, run this after your final message, and only when the user asks to close or archive the thread:

```bash
kimaki session archive <thread_id>
```
