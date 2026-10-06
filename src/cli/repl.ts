/**
 * `deepclause repl` — the DML REPL.
 *
 * M1 implements goal mode: `goal: <dml>.` runs a DML goal, anything else is
 * classified as an English prompt (prompt mode lands in M3). A small set of
 * out-of-band commands (`halt.`, `help.`, `listing.`, `reset.`, …) is matched
 * as whole-line keywords before the classifier.
 */

import type { Command } from 'commander';
import * as path from 'path';
import * as readline from 'readline';

import { createHarnessRepl, type HarnessRepl } from '../repl/index.js';
import { ReplRenderer, type RenderMode } from '../repl/render.js';
import { parseModelId, type Provider } from '../system/config/model-slots.js';
import { loadReplConfig } from './config.js';

export interface ReplCliOptions {
  goal?: string[];
  load?: string[];
  first?: boolean;
  plain?: boolean;
  json?: boolean;
  workspace?: string;
  model?: string;
  provider?: string;
  temperature?: number;
  gasLimit?: number;
  param?: Record<string, string>;
  verbose?: boolean;
  color?: boolean;
  freeze?: boolean;
  locked?: boolean;
  exportPath?: string;
}

export type ReplInput =
  | { kind: 'empty' }
  | { kind: 'comment' }
  | { kind: 'halt' }
  | { kind: 'help' }
  | { kind: 'listing'; filter?: string }
  | { kind: 'reset' }
  | { kind: 'export'; path?: string }
  | { kind: 'freeze' }
  | { kind: 'unfreeze' }
  | { kind: 'trace' }
  | { kind: 'notrace' }
  | { kind: 'params' }
  | { kind: 'goal'; goal: string }
  | { kind: 'prompt'; prompt: string };

const OUT_OF_BAND = new Set(['halt', 'help', 'reset', 'freeze', 'unfreeze', 'trace', 'notrace', 'params']);

/**
 * Classify one REPL input line.
 *
 * Rules (proposal §9.1): out-of-band commands are matched first as whole-line
 * keywords; `goal:` selects goal mode; everything else is an English prompt.
 * A `goal:` payload is never reinterpreted as a prompt.
 */
export function classifyReplInput(line: string): ReplInput {
  const trimmed = line.trim();
  if (!trimmed) {
    return { kind: 'empty' };
  }
  if (trimmed.startsWith('%')) {
    return { kind: 'comment' };
  }

  // Out-of-band commands: whole line, optional trailing full stop.
  const commandLine = trimmed.replace(/\.\s*$/, '').trim();
  if (OUT_OF_BAND.has(commandLine)) {
    return { kind: commandLine } as ReplInput;
  }
  if (commandLine === 'listing') {
    return { kind: 'listing' };
  }
  if (commandLine.startsWith('listing(') && commandLine.endsWith(')')) {
    const filter = commandLine.slice('listing('.length, -1).trim();
    return { kind: 'listing', filter: filter || undefined };
  }
  if (commandLine === 'export') {
    return { kind: 'export' };
  }
  if (commandLine.startsWith('export ')) {
    return { kind: 'export', path: commandLine.slice('export '.length).trim() || undefined };
  }

  if (trimmed.startsWith('goal:')) {
    return { kind: 'goal', goal: trimmed.slice('goal:'.length).trim() };
  }

  return { kind: 'prompt', prompt: trimmed };
}

/** Run one goal and render its solutions. Returns a process exit code. */
export async function runGoalWithRenderer(
  repl: HarnessRepl,
  goal: string,
  options: { first?: boolean; renderer: ReplRenderer },
): Promise<number> {
  let hadError = false;
  let printedAny = false;
  for await (const event of repl.query(goal)) {
    if (event.type === 'solution') {
      options.renderer.solution(event.solution?.bindings ?? []);
      printedAny = true;
      if (options.first) break;
    } else if (event.type === 'error') {
      hadError = true;
      options.renderer.render(event);
    } else if (event.type === 'finished') {
      // Nothing to print for finished.
    } else {
      options.renderer.render(event);
    }
  }
  if (!printedAny && !hadError) {
    options.renderer.writeLine('false.');
  }
  return hadError ? 1 : 0;
}

function selectRenderMode(options: ReplCliOptions): RenderMode {
  if (options.json) return 'json';
  if (options.plain) return 'plain';
  return process.stdout.isTTY ? 'rich' : 'plain';
}

function resolveModel(modelId: string): { provider: Provider; model: string } {
  try {
    const parsed = parseModelId(modelId);
    return { provider: parsed.provider, model: parsed.model };
  } catch {
    return { provider: 'openai', model: modelId };
  }
}

export interface ReplRuntime {
  repl: HarnessRepl;
  renderer: ReplRenderer;
  workspace: string;
  promptPrefix: string;
}

/** Build the harness + renderer from CLI options. */
export async function createReplRuntime(options: ReplCliOptions): Promise<ReplRuntime> {
  const workspace = path.resolve(options.workspace ?? './');
  const config = await loadReplConfig(workspace);
  const modelId = options.model ?? config.models.run;
  const resolved = resolveModel(modelId);
  const provider = (options.provider as Provider | undefined) ?? resolved.provider;

  const renderer = new ReplRenderer({
    mode: selectRenderMode(options),
    color: options.color !== false && config.repl.color !== false,
    verbose: options.verbose ?? false,
  });

  const repl = await createHarnessRepl({
    workspacePath: workspace,
    model: resolved.model,
    provider,
    temperature: options.temperature ?? config.temperatures.run,
    params: options.param ?? {},
    gasLimit: options.gasLimit,
    onInputRequired: async () => '',
  });

  return {
    repl,
    renderer,
    workspace,
    promptPrefix: config.repl.promptPrefix ?? 'dml> ',
  };
}

/** Dispatch one classified input. Returns false when the REPL should exit. */
export async function dispatchReplInput(
  runtime: ReplRuntime,
  input: ReplInput,
  options: { first?: boolean; print?: (text: string) => void; exportPath?: string } = {},
): Promise<boolean> {
  const { repl, renderer } = runtime;
  const print = options.print ?? ((text: string) => renderer.writeLine(text));
  switch (input.kind) {
    case 'empty':
    case 'comment':
      return true;
    case 'halt':
      return false;
    case 'help':
      print(helpText(runtime));
      return true;
    case 'listing': {
      const text = await repl.list(input.filter);
      print(text.trimEnd() || '% (empty harness)');
      return true;
    }
    case 'reset':
      if (repl.isFrozen()) {
        print('ERROR: harness is frozen; reset is disabled. Use \'unfreeze.\' first.');
        return true;
      }
      await repl.reset();
      print('harness reset');
      return true;
    case 'export': {
      const target = input.path ?? options.exportPath ?? 'harness.dml';
      try {
        const result = await repl.export(target);
        print(`exported ${result.clauses} clauses, ${result.tools} tools, ${result.scripts} scripts → ${result.path}`);
      } catch (error) {
        print(`ERROR: ${(error as Error).message}`);
      }
      return true;
    }
    case 'freeze':
      await repl.freeze();
      print(`harness frozen: assert/retract/load disabled. Use 'unfreeze.' to re-enable.`);
      return true;
    case 'unfreeze':
      try {
        await repl.unfreeze();
        print('harness unfrozen');
      } catch (error) {
        print(`ERROR: ${(error as Error).message}`);
      }
      return true;
    case 'trace':
      print('trace enabled');
      return true;
    case 'notrace':
      print('trace disabled');
      return true;
    case 'params':
      print('params: (see session configuration)');
      return true;
    case 'goal':
      await runGoalWithRenderer(repl, input.goal, { first: options.first, renderer });
      return true;
    case 'prompt': {
      for await (const event of repl.prompt(input.prompt)) {
        renderer.render(event);
      }
      return true;
    }
    default:
      return true;
  }
}

function helpText(runtime: ReplRuntime): string {
  return [
    'DML REPL help',
    '  goal: <dml>.        run a DML goal (enumerates solutions)',
    '  <english text>      build the harness from a prompt (M3)',
    '  listing.            list the living module',
    '  listing(Name/Arity). list one predicate',
    '  reset.              empty the harness',
    '  export <file>.      write a self-contained harness',
    '  freeze. / unfreeze. read-only lock',
    '  params.             show session parameters',
    '  trace. / notrace.   toggle verbose logging',
    '  halt.               exit',
    `  prompt: ${runtime.promptPrefix}`,
  ].join('\n');
}

async function executeLoad(runtime: ReplRuntime, files: string[]): Promise<number> {
  for (const file of files) {
    const target = path.isAbsolute(file) ? file : path.resolve(runtime.workspace, file);
    const result = await runtime.repl.load(target);
    if (result.error) {
      runtime.renderer.writeErrorLine(`ERROR: ${result.error}`);
      return 1;
    }
    runtime.renderer.writeLine(`loaded ${file}`);
  }
  return 0;
}

/** Non-interactive mode: read classified inputs line by line until EOF. */
async function runNonInteractive(runtime: ReplRuntime, options: ReplCliOptions): Promise<number> {
  let exitCode = 0;
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const input = classifyReplInput(line);
      if (input.kind === 'halt') break;
      const keepGoing = await dispatchReplInput(runtime, input, { first: options.first, exportPath: options.exportPath });
      if (!keepGoing) break;
    }
  } finally {
    rl.close();
  }
  return exitCode;
}

/** Interactive mode with the `dml>` prompt and a `;`/`.` pager for goals. */
async function runInteractive(runtime: ReplRuntime, options: ReplCliOptions): Promise<number> {
  const { promptPrefix } = runtime;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  const lines = rl[Symbol.asyncIterator]();
  const nextLine = async (): Promise<string | null> => {
    const { value, done } = await lines.next();
    return done ? null : String(value);
  };

  try {
    while (true) {
      process.stdout.write(promptPrefix);
      const line = await nextLine();
      if (line === null) break;
      const input = classifyReplInput(line);
      if (input.kind === 'halt') break;

      if (input.kind === 'goal') {
        await runInteractiveGoal(runtime, input.goal, options, nextLine);
      } else {
        const keepGoing = await dispatchReplInput(runtime, input, { first: options.first, exportPath: options.exportPath });
        if (!keepGoing) break;
      }
    }
  } finally {
    rl.close();
  }
  return 0;
}

async function runInteractiveGoal(
  runtime: ReplRuntime,
  goal: string,
  options: ReplCliOptions,
  nextLine: () => Promise<string | null>,
): Promise<void> {
  const { renderer, repl } = runtime;
  const iterator = repl.query(goal)[Symbol.asyncIterator]();
  let answered = false;
  let pageAll = false;
  try {
    while (true) {
      const { value, done } = await iterator.next();
      if (done) break;
      if (value.type === 'solution') {
        renderer.solution(value.solution?.bindings ?? [], '');
        answered = true;
        if (options.first) {
          renderer.writeLine('.');
          await iterator.return?.(undefined);
          return;
        }
        if (!pageAll) {
          const key = await nextLine();
          const trimmed = (key ?? '').trim();
          if (trimmed === '.') {
            renderer.writeLine('.');
            await iterator.return?.(undefined);
            return;
          }
          if (trimmed === 'a') {
            pageAll = true;
          }
        }
      } else if (value.type === 'error') {
        renderer.render(value);
      }
    }
  } finally {
    await iterator.return?.(undefined);
  }
  renderer.writeLine(answered ? '.' : 'false.');
}

/** Entry point for `deepclause repl`. */
export async function startRepl(options: ReplCliOptions): Promise<number> {
  const runtime = await createReplRuntime(options);
  try {
    const loadExit = await executeLoad(runtime, options.load ?? []);
    if (loadExit !== 0) {
      return loadExit;
    }

    // Freeze/lock only after all `-l` loads succeed (load before lock).
    if (options.locked) {
      await runtime.repl.lock();
    } else if (options.freeze) {
      await runtime.repl.freeze();
    }

    const goals = options.goal ?? [];
    if (goals.length > 0) {
      let exitCode = 0;
      for (const goal of goals) {
        const code = await runGoalWithRenderer(runtime.repl, goal, {
          first: options.first,
          renderer: runtime.renderer,
        });
        if (code !== 0) exitCode = code;
      }
      return exitCode;
    }

    if (!process.stdin.isTTY) {
      return await runNonInteractive(runtime, options);
    }
    return await runInteractive(runtime, options);
  } finally {
    if (options.exportPath) {
      try {
        const result = await runtime.repl.export(options.exportPath);
        runtime.renderer.writeLine(
          `exported ${result.clauses} clauses, ${result.tools} tools, ${result.scripts} scripts → ${result.path}`,
        );
      } catch (error) {
        runtime.renderer.writeErrorLine(`ERROR: ${(error as Error).message}`);
      }
    }
    await runtime.repl.dispose();
  }
}

/** Register the `repl` command on the CLI program. */
export function registerReplCommand(program: Command): void {
  program
    .command('repl')
    .description('Interactive DML REPL (goal mode; English prompts build the harness)')
    .option('-g, --goal <goal>', 'run one goal and exit (repeatable)', collect)
    .option('-l, --load <file>', 'load a DML file before starting (repeatable)', collect)
    .option('--first', 'with a goal, print only the first solution')
    .option('--plain', 'no TUI formatting (auto when stdout is not a TTY)')
    .option('--json', 'emit results as JSON lines')
    .option('--workspace <path>', 'workspace root for file operations', './')
    .option('--model <model>', 'override the configured run model')
    .option('--provider <provider>', 'override the configured provider')
    .option('--temperature <number>', 'override temperature (0.0-2.0)', parseFloat)
    .option('--gas-limit <number>', 'per-frame step limit', parseInt)
    .option('-P, --param <key=value>', 'session parameter (repeatable)', collectParams, {})
    .option('-f, --freeze', 'start with the harness frozen (read-only lock)')
    .option('--locked', 'like --freeze, but forbid unfreeze for this process')
    .option('--export <file>', 'export the harness on exit')
    .option('--verbose', 'show debug output')
    .option('--debug', 'show debug output')
    .option('--no-color', 'disable ANSI color')
    .action(async (options) => {
      const exitCode = await startRepl({
        goal: options.goal,
        load: options.load,
        first: options.first,
        plain: options.plain,
        json: options.json,
        workspace: options.workspace,
        model: options.model,
        provider: options.provider,
        temperature: options.temperature,
        gasLimit: options.gasLimit,
        param: options.param,
        verbose: Boolean(options.verbose || options.debug),
        color: options.color,
        freeze: options.freeze,
        locked: options.locked,
        exportPath: options.export,
      });
      if (exitCode !== 0) {
        process.exit(exitCode);
      }
    });
}

function collect(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

function collectParams(value: string, previous: Record<string, string>): Record<string, string> {
  const [key, val] = value.split('=');
  if (!key || val === undefined) {
    throw new Error(`Invalid param format: ${value}. Use key=value`);
  }
  return { ...previous, [key]: val };
}
