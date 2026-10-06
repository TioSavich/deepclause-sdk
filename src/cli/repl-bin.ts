#!/usr/bin/env node
/**
 * deepclause-repl — thin alias for `deepclause repl`.
 *
 * Accepts exactly the same options as `deepclause repl`; it simply prepends the
 * `repl` subcommand before dispatching to the shared command definition.
 */

import { Command } from 'commander';
import { registerReplCommand } from './repl.js';

const program = new Command();
program
  .name('deepclause-repl')
  .description('Alias for `deepclause repl` (same options)');

registerReplCommand(program);

await program.parseAsync(['node', 'deepclause-repl', 'repl', ...process.argv.slice(2)]);
