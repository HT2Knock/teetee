// Preloaded before every `bun test` run (bunfig.toml). Sets the flag the logger
// reads, so test runs are silent unless KIMAKI_TEST_LOGS=1.
process.env['KIMAKI_TEST'] = '1'
