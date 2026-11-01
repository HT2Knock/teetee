// Preloaded before every `bun test` run (bunfig.toml). Sets the flag the logger
// reads, so test runs are silent unless KIMAKI_TEST_LOGS=1.
process.env['KIMAKI_TEST'] = '1'

// The footer shows the branch of the project folder, and onboarding runs
// `git init` for a new project folder. Pin the branch name so the snapshots do
// not depend on the machine's `init.defaultBranch` (CI used to say master).
process.env['GIT_CONFIG_COUNT'] = '1'
process.env['GIT_CONFIG_KEY_0'] = 'init.defaultBranch'
process.env['GIT_CONFIG_VALUE_0'] = 'main'
