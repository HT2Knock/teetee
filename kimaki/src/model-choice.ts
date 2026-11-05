// A model as the bot passes it around: "providerID/modelID" plus an optional
// variant. Pure string parsing, so the model rules can be tested without a bot.
//
// It lives here, not in bot.ts, because send-policy.ts and the preference
// commands need it and bot.ts imports the Discord client.

export type ModelChoice = { providerID: string; id: string; variant: string | null }

export function parseModel(value: string | null | undefined, variant: string | null | undefined) {
  if (!value) return null
  const slash = value.indexOf('/')
  if (slash <= 0) return null
  return {
    providerID: value.slice(0, slash),
    id: value.slice(slash + 1),
    ...(variant && { variant }),
  }
}
