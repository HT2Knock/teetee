// The Discord half of the questions feature: dropdown and "Other" modal
// handlers that answer a pending form. The fold lives in questions-slice.ts, so
// this module may import the bot and discord.js.
//
// Custom IDs carry only the form ID and field index. Answers of a form with
// several questions wait in the createQuestionHandlers closure until the last
// one (lost on restart, the user picks again).

import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from '../../adapters/discord/index.ts'
import { oc, type Bot } from '../../bot.ts'
import { createLogger } from '../../platform/logger.ts'
import type { InteractionRoutes } from '../session/interaction-context.ts'

import {
  FORM_OTHER_PREFIX,
  FORM_SELECT_PREFIX,
  OTHER_VALUE,
  answeredMessage,
  fieldValue,
  formatAnswer,
  type FieldValue,
  type PendingForm,
  type QuestionField,
} from './slice.ts'

const logger = createLogger('QUESTION')

function parseCustomId(customId: string, prefix: string): { formID: string; index: number } | null {
  const [formID, index] = customId.slice(prefix.length).split(':')
  const parsed = Number(index)
  if (!formID || !Number.isInteger(parsed)) return null
  return { formID, index: parsed }
}

// Shows the answer in the question's own message.
async function acknowledge({
  interaction,
  content,
}: {
  interaction: StringSelectMenuInteraction | ModalSubmitInteraction
  content: string
}) {
  if (interaction.isStringSelectMenu() || interaction.isFromMessage()) {
    await interaction.update({ content, components: [] })
    return
  }
  await interaction.reply({ content, flags: MessageFlags.Ephemeral })
}

async function expired(interaction: StringSelectMenuInteraction | ModalSubmitInteraction) {
  await interaction.reply({ content: 'This question is no longer pending', flags: MessageFlags.Ephemeral })
}

// The dropdown and "Other" modal handlers of question forms. One per bot.
export function createQuestionHandlers(): InteractionRoutes {
  // formID -> answers so far, for forms with several fields.
  const answers = new Map<string, { readonly [key: string]: FieldValue }>()
  // "formID:key" -> options picked together with "Other", while the modal asks for the text.
  const otherPicks = new Map<string, readonly string[]>()

  function pendingField(
    bot: Bot,
    { threadId, customId, prefix }: { threadId: string; customId: string; prefix: string },
  ) {
    const parsed = parseCustomId(customId, prefix)
    if (!parsed) return null
    const form = bot.store.getState().threads[threadId]?.forms[parsed.formID]
    const field = form?.fields[parsed.index]
    if (!form || !field) {
      answers.delete(parsed.formID)
      return null
    }
    return { formID: parsed.formID, form, field }
  }

  async function record(
    bot: Bot,
    {
      interaction,
      formID,
      form,
      field,
      value,
    }: {
      interaction: StringSelectMenuInteraction | ModalSubmitInteraction
      formID: string
      form: PendingForm
      field: QuestionField
      value: FieldValue
    },
  ) {
    const answer = { ...answers.get(formID), [field.key]: value }
    const complete = form.fields.every((candidate) => answer[candidate.key] !== undefined)
    if (complete) answers.delete(formID)
    if (!complete) answers.set(formID, answer)
    const answered = answeredMessage({ field, label: form.label, answer: formatAnswer({ field, value }) })
    await acknowledge({ interaction, content: answered.content })
    if (!complete) return
    const result = await oc(bot, 'session.form.reply', (client) =>
      client.session.form.reply({ sessionID: form.sessionId, formID, answer }),
    )
    if (!(result instanceof Error)) return
    logger.warn(`answer ${formID} failed`, result)
    await interaction.followUp({ content: 'This question is no longer pending', flags: MessageFlags.Ephemeral })
  }

  async function select(bot: Bot, interaction: StringSelectMenuInteraction): Promise<void> {
    const pending = pendingField(bot, {
      threadId: interaction.channelId,
      customId: interaction.customId,
      prefix: FORM_SELECT_PREFIX,
    })
    if (!pending) return expired(interaction)
    const { formID, field } = pending
    const values = interaction.values.flatMap((value) => {
      const option = field.options[Number(value)]
      return option ? [option.value] : []
    })
    if (interaction.values.includes(OTHER_VALUE)) {
      otherPicks.set(`${formID}:${field.key}`, values)
      const input = new TextInputBuilder()
        .setCustomId('answer')
        .setLabel('Your answer')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId(interaction.customId.replace(FORM_SELECT_PREFIX, FORM_OTHER_PREFIX))
          .setTitle((field.title || 'Answer').slice(0, 45))
          .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input)),
      )
      return
    }
    const value = fieldValue({ field, values })
    await record(bot, { interaction, ...pending, value })
  }

  async function other(bot: Bot, interaction: ModalSubmitInteraction): Promise<void> {
    const pending = pendingField(bot, {
      threadId: interaction.channelId ?? '',
      customId: interaction.customId,
      prefix: FORM_OTHER_PREFIX,
    })
    if (!pending) return expired(interaction)
    const text = interaction.fields.getTextInputValue('answer').trim()
    const key = `${pending.formID}:${pending.field.key}`
    const picked = otherPicks.get(key) ?? []
    otherPicks.delete(key)
    await record(bot, {
      interaction,
      ...pending,
      value: pending.field.type === 'multiselect' ? [...picked, text] : text,
    })
  }

  return { selects: { [FORM_SELECT_PREFIX]: select }, modals: { [FORM_OTHER_PREFIX]: other } }
}
