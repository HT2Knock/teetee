// Discord enum values without discord.js. The pure modules (the reducer and its
// slices, formatting) need component styles and message flags; importing them
// from `index.ts` would pull discord.js into their runtime closure and break the
// boundary the reducer relies on (see reducer-boundary.test.ts).
//
// Values only: no client, no builders. Those stay in `index.ts`.

export { ButtonStyle, ComponentType, MessageFlags } from 'discord-api-types/v10'
