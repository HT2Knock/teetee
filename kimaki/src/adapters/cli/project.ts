// Project, channel and worktree commands. `project` changes and reads through
// the running bot; channel settings and worktrees go through the bot too.

import path from 'node:path'

import type { Goke } from 'goke'

import { callBot } from '../http/rpc.ts'

import { action, DATA_DIR_HELP, dataDirOrDefault, fail, printJson } from './shared.ts'

const WORKTREE_TIMEOUT_MS = 25 * 60_000

export function registerProjectCommands(cli: Goke) {
  cli
    .command('project list', 'List project directories and their channels')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      const result = await callBot({ dataDir: dataDirOrDefault(options.dataDir), route: 'project.list', input: {} })
      if (result instanceof Error) fail(result)
      const rows = result.data
      if (options.json) return printJson(rows)
      for (const row of rows) process.stdout.write(`<#${row.channelId}> ${row.directory}\n`)
    })

  cli
    .command('project add [directory]', 'Create a channel for a directory (default: current directory)')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('-g, --guild <guildId>', 'Server (default: the one with Kimaki channels)')
    .option('--machine-name <name>', 'Machine name of a new category and of a channel name suffix (default: hostname)')
    .action(async (directory, options) => {
      const result = await callBot({
        dataDir: dataDirOrDefault(options.dataDir),
        route: 'project.add',
        input: {
          directory: path.resolve(directory ?? process.cwd()),
          guild: options.guild,
          machine: options.machineName,
        },
      })
      if (result instanceof Error) fail(result)
      process.stdout.write(
        `${result.data.created ? 'Added' : 'Already added'} <#${result.data.channelId}> for ${result.data.directory}\n`,
      )
    })
}

// channel agent / model / verbosity
export function registerChannelPreferenceCommands(cli: Goke) {
  cli
    .command('channel agent [value]', 'Set channel agent through the running bot')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('-c, --channel <id>', 'Target channel (default: current project)')
    .option('--clear', 'Clear the saved agent')
    .action(async (value, options) => {
      await action({
        route: 'channel.agent',
        dataDir: options.dataDir,
        input: { channelId: options.channel, directory: process.cwd(), agent: value, clear: options.clear },
      })
    })
  cli
    .command('channel model [value]', 'Set channel model through the running bot')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('-c, --channel <id>', 'Target channel (default: current project)')
    .option('--variant <name>', 'Thinking variant for model')
    .option('--global', 'Default of all channels without their own model')
    .option('--clear', 'Clear the saved model')
    .action(async (value, options) => {
      const model = { model: value, variant: options.variant, clear: options.clear }
      if (options.global) {
        await action({ route: 'global.model', dataDir: options.dataDir, input: model })
        return
      }
      await action({
        route: 'channel.model',
        dataDir: options.dataDir,
        input: { channelId: options.channel, directory: process.cwd(), ...model },
      })
    })
  // A missing verbosity gets the bot's "Invalid channel action or value".
  cli
    .command('channel verbosity [value]', 'Set channel verbosity through the running bot')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('-c, --channel <id>', 'Target channel (default: current project)')
    .action(async (value, options) => {
      await action({
        route: 'channel.verbosity',
        dataDir: options.dataDir,
        input: { channelId: options.channel, directory: process.cwd(), text: value ?? '' },
      })
    })
}

export function registerChannelWorktreeCommand(cli: Goke) {
  cli
    .command('channel worktrees <value>', 'Set automatic worktrees: on | off')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('-c, --channel <id>', 'Project channel (default: current directory)')
    .action(async (value, options) => {
      await action({
        route: 'channel.worktrees',
        dataDir: options.dataDir,
        input: { channelId: options.channel, directory: process.cwd(), text: value },
      })
    })
}

export function registerWorktreeCommands(cli: Goke) {
  cli
    .command('worktree list', 'List linked Git worktrees')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('-c, --channel <id>', 'Project channel')
    .option('-p, --project <path>', 'Project directory (default: current directory)')
    .action(async (options) => {
      await action({
        route: 'worktree.list',
        dataDir: options.dataDir,
        input: { channelId: options.channel, directory: path.resolve(options.project ?? process.cwd()) },
      })
    })

  cli
    .command('worktree create [name]', 'Create an isolated worktree session')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('-c, --channel <id>', 'Project channel')
    .option('-p, --project <path>', 'Project directory (default: current directory)')
    .option('--base-branch <ref>', 'Starting Git ref (default: project HEAD)')
    .action(async (name, options) => {
      const input = {
        channelId: options.channel,
        directory: path.resolve(options.project ?? process.cwd()),
        name,
        baseBranch: options.baseBranch,
      }
      await action({
        route: 'worktree.create',
        dataDir: options.dataDir,
        input,
        signal: AbortSignal.timeout(WORKTREE_TIMEOUT_MS),
      })
    })

  for (const operation of ['remove', 'merge'] as const) {
    cli
      .command(
        `worktree ${operation} <directory>`,
        operation === 'merge'
          ? 'Merge into a local target branch'
          : 'Remove a clean, merged worktree checkout; retain branch refs',
      )
      .option('--data-dir <path>', DATA_DIR_HELP)
      .option('-c, --channel <id>', 'Project channel')
      .option('-p, --project <path>', 'Project directory (default: current directory)')
      .option('--target-branch <branch>', 'Local merge target branch')
      .option('--strategy <name>', 'Merge strategy: rebase | squash')
      .action(async (directory, options) => {
        const input = {
          channelId: options.channel,
          directory: path.resolve(options.project ?? process.cwd()),
          text: path.resolve(directory),
          targetBranch: options.targetBranch,
          strategy: options.strategy,
        }
        await action({
          route: `worktree.${operation}`,
          dataDir: options.dataDir,
          input,
          signal: AbortSignal.timeout(WORKTREE_TIMEOUT_MS),
        })
      })
  }
}
