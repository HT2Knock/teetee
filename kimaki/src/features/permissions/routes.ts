// The Discord half of the permissions feature: the Accept / Accept Always /
// Deny buttons. The fold lives in permissions-slice.ts, so this module may
// import the bot.

import { MessageFlags, type ButtonInteraction } from '../../adapters/discord/index.ts'
import { oc, type Bot } from '../../bot.ts'
import { createLogger } from '../../platform/logger.ts'
import type { InteractionRoutes } from '../session/interaction-context.ts'

import { PERMISSION_PREFIX, type PermissionDecision } from './slice.ts'

const logger = createLogger('PERMISSION')

function parseDecision(value: string | undefined): PermissionDecision | null {
  return value === 'once' || value === 'always' || value === 'reject' ? value : null
}

async function handlePermissionButton(bot: Bot, interaction: ButtonInteraction): Promise<void> {
  const [requestID, rawDecision] = interaction.customId.slice(PERMISSION_PREFIX.length).split(':')
  const decision = parseDecision(rawDecision)
  const request = requestID ? bot.store.getState().threads[interaction.channelId]?.permissions[requestID] : undefined
  if (!requestID || !decision || !request) {
    await interaction.reply({ content: 'This permission request is no longer pending', flags: MessageFlags.Ephemeral })
    return
  }
  // The buttons go away when permission.replied arrives.
  await interaction.deferUpdate()
  const result = await oc(bot, 'permission.reply', (client) =>
    client.permission.reply({ sessionID: request.sessionId, requestID, decision }),
  )
  if (!(result instanceof Error)) return
  logger.warn(`reply ${requestID} failed`, result)
  await interaction.followUp({ content: 'This permission request is no longer pending', flags: MessageFlags.Ephemeral })
}

export const permissionRoutes: InteractionRoutes = { buttons: { [PERMISSION_PREFIX]: handlePermissionButton } }
