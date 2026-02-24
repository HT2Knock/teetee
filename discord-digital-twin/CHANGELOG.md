# Changelog

## 0.0.1

Initial release.

- Local Discord API twin (REST + Gateway WebSocket) for testing discord.js bots
- In-memory state with Prisma + libsql
- Full message lifecycle: create, edit, delete, reactions
- Thread management: create, archive, unarchive, thread members
- Interaction flows: slash commands, buttons, select menus, modals
- Guild management: channels, roles, members, active threads
- Playwright-style actor API: `discord.user(id).sendMessage(...)`, `.runSlashCommand(...)`, etc.
- Wait helpers: `waitForThread`, `waitForMessage`, `waitForBotReply`, `waitForInteractionAck`
