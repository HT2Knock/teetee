// The routine that started a session (scheduler.ts), set once at session.create
// so the instruction entry stays stable across turns.
//
// It lives here, not in system-prompt.ts, because bot.ts, sessions.ts, input.ts
// and session-context.ts need the type only. Importing it from the instruction
// text would put the whole agent manual in their dependency graph.

export type ScheduledRun = { id: number; cronExpr: string | null; timezone: string | null }
