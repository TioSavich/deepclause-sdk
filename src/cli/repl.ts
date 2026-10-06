/**
 * `deepclause repl` — the DML REPL.
 *
 * M1 implements goal mode: `goal: <dml>.` runs a DML goal, anything else is
 * classified as an English prompt (prompt mode lands in M3). A small set of
 * out-of-band commands (`halt.`, `help.`, `listing.`, `reset.`, …) is matched
 * as whole-line keywords before the classifier.
 */

import type { Command } from 'commander';
import { readFileSync } from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { fileURLToPath } from 'url';

import { createHarnessRepl, type HarnessRepl } from '../repl/index.js';
import { resolveReplJudgeSelection } from '../repl/judge.js';
import { ReplRenderer, type RenderMode } from '../repl/render.js';
import { createPiBackend } from '../repl/backend.js';
import { createReplToolset, type ReplToolset } from '../repl/toolset.js';
import { parseModelId, type Provider } from '../system/config/model-slots.js';
import { loadReplConfig, updateConfig } from './config.js';

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
  depth?: number;
  maxModelCalls?: number;
  param?: Record<string, string>;
  verbose?: boolean;
  color?: boolean;
  freeze?: boolean;
  locked?: boolean;
  exportPath?: string;
  backend?: 'env' | 'pi';
  /** Render streamed model text/reasoning (default true). */
  stream?: boolean;
  /** Render activity events (task activity, tool calls, usage, logs; default true). */
  events?: boolean;
  /** Default judgment backend name (llm|jev). */
  judge?: string;
  tools?: string;
  noTools?: boolean;
  sandbox?: boolean;
  noAsk?: boolean;
  answer?: string;
  interactiveInput?: boolean;
}

export type ReplInput =
  | { kind: 'empty' }
  | { kind: 'comment' }
  | { kind: 'halt' }
  | { kind: 'help' }
  | { kind: 'listing'; filter?: string }
  | { kind: 'reset' }
  | { kind: 'rollback' }
  | { kind: 'model'; model?: string }
  | { kind: 'export'; path?: string }
  | { kind: 'freeze' }
  | { kind: 'unfreeze' }
  | { kind: 'trace' }
  | { kind: 'notrace' }
  | { kind: 'params' }
  | { kind: 'goal'; goal: string }
  | { kind: 'prompt'; prompt: string };

const OUT_OF_BAND = new Set(['halt', 'help', 'reset', 'rollback', 'freeze', 'unfreeze', 'trace', 'notrace', 'params']);

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
  if (commandLine === 'model') {
    return { kind: 'model' };
  }
  if (commandLine.startsWith('model ')) {
    return { kind: 'model', model: commandLine.slice('model '.length).trim() || undefined };
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
  options: { first?: boolean; renderer: ReplRenderer; signal?: AbortSignal },
): Promise<number> {
  let hadError = false;
  let printedAny = false;
  for await (const event of repl.query(goal, { signal: options.signal })) {
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

/**
 * Build the unified input channel from CLI flags (proposal §13.6):
 *  - `--answer` supplies a canned reply; `--no-ask` fails immediately;
 *  - a TTY (or `--interactive-input`) prompts;
 *  - everything else returns undefined so autonomous runs never block.
 */
export function buildCliOnInput(
  options: ReplCliOptions,
): ((prompt: string, choices?: string[]) => Promise<string | undefined>) | undefined {
  if (options.answer !== undefined) {
    return async () => options.answer;
  }
  if (options.noAsk) {
    return async () => undefined;
  }
  const interactive = Boolean(process.stdin.isTTY) || Boolean(options.interactiveInput);
  if (!interactive) {
    return async () => undefined;
  }
  return async (prompt, choices) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const suffix = choices && choices.length > 0 ? ` (${choices.join('/')})` : '';
      return await new Promise<string>((resolve) => rl.question(`${prompt}${suffix}\n> `, resolve));
    } finally {
      rl.close();
    }
  };
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
  toolset: ReplToolset;
  /** Package version, shown in the startup banner. */
  version: string;
  /** Resolved model and backend, shown in the startup banner. */
  model: string;
  backend: 'env' | 'pi';
  /** Replace the input channel (the interactive loop uses its own readline). */
  setOnInput(handler: (prompt: string, choices?: string[]) => Promise<string | undefined>): void;
  /** Set when the env backend has no credentials for the selected provider. */
  missingCredential?: string;
}

const PROVIDER_ENV_KEYS: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

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
    stream: options.stream !== false,
    events: options.events !== false,
  });

  // `null` means no capability tools; `undefined` means use the default
  // (bash). An explicit `tools: []` in config also disables capability tools.
  const toolNames = options.noTools
    ? null
    : options.tools
      ? options.tools.split(',').map((name) => name.trim()).filter(Boolean)
      : (config.repl.tools ?? undefined);
  const toolset = await createReplToolset({
    workspacePath: workspace,
    sandbox: options.sandbox,
    network: config.agentvm?.network ?? false,
    hostConfig: config.shell,
    toolNames,
    // The runner already emits the tool_call start/completion events, so the
    // shell bridge here only forwards stream/log lines to avoid duplicates.
    onEvent: (event) => {
      if (event.type !== 'tool_call') {
        renderer.render(event);
      }
    },
  });

  const backendKind = options.backend ?? config.backend?.kind ?? 'pi';
  let llmBackend;
  let harnessModel = resolved.model;
  let harnessProvider: Provider = provider;
  if (backendKind === 'pi') {
    try {
      const pi = await createPiBackend({
        agentDir: config.backend?.agentDir,
        modelsPath: config.backend?.modelsPath ?? undefined,
        authPath: config.backend?.authPath ?? undefined,
        model: options.model ?? config.backend?.model,
      });
      llmBackend = pi.backend;
      harnessModel = pi.modelId.split('/').slice(1).join('/') || pi.modelId;
      harnessProvider = (pi.provider as Provider) ?? harnessProvider;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `pi backend unavailable: ${message}\n`
        + "Run 'deepclause login' to sign in, or 'deepclause set-backend env' to use provider API keys.",
      );
    }
  }

  // Judgment backends. `llm` reuses the active model/backend; `jev` is opt-in
  // and only registered when enabled and its API key is present. Building the
  // registry here (rather than in createHarnessRepl) lets the CLI report a
  // skipped `jev` backend and honor --judge.
  const { selection: judgeSelection, warnings: judgeWarnings } = resolveReplJudgeSelection({
    llmBackend,
    model: harnessModel,
    provider: harnessProvider,
    temperature: options.temperature ?? config.temperatures.run,
    defaultJudge: options.judge ?? config.judgment.default,
    jev: {
      enabled: config.judgment.jev.enabled,
      model: config.judgment.jev.model,
      apiKeyEnv: config.judgment.jev.apiKeyEnv,
    },
  });
  for (const warning of judgeWarnings) {
    process.stderr.write(`[deepclause] ${warning}\n`);
  }

  const repl = await createHarnessRepl({
    workspacePath: workspace,
    model: harnessModel,
    provider: harnessProvider,
    temperature: options.temperature ?? config.temperatures.run,
    params: options.param ?? {},
    gasLimit: options.gasLimit,
    maxDepth: options.depth ?? config.repl.maxDepth,
    maxModelCalls: options.maxModelCalls ?? config.repl.maxModelCalls,
    repairRounds: config.repl.repairRounds,
    tools: toolset.tools,
    hostToolsCatalog: toolset.catalog,
    llmBackend,
    judgeSelection,
    history: config.repl.history.enabled
      ? {
          dir: config.repl.history.dir,
          trace: config.repl.history.trace,
          maxEventBytes: config.repl.history.maxEventBytes,
          maxSessions: config.repl.history.maxSessions,
          maxVersions: config.repl.history.maxVersions,
          includeInExport: config.repl.history.includeInExport,
          redact: config.repl.history.redact,
        }
      : undefined,
    onInput: buildCliOnInput(options),
  });

  let missingCredential: string | undefined;
  if (backendKind === 'env') {
    const envKey = PROVIDER_ENV_KEYS[harnessProvider];
    const configured = config.providers?.[harnessProvider]?.apiKey;
    if (envKey && !configured && !process.env[envKey]) {
      missingCredential = `no credentials for provider '${harnessProvider}'. `
        + `Set ${envKey}, configure providers.${harnessProvider}.apiKey, `
        + "or run 'deepclause set-backend pi'.";
    }
  }

  return {
    repl,
    renderer,
    workspace,
    promptPrefix: config.repl.promptPrefix ?? 'dml> ',
    toolset,
    version: PACKAGE_VERSION,
    model: backendKind === 'pi' ? harnessModel : `${harnessProvider}:${harnessModel}`,
    backend: backendKind,
    setOnInput: (handler) => repl.setOnInput(handler),
    missingCredential,
  };
}

/** Startup banner for the interactive REPL (proposal §2.1). */
/** Package version, read once from package.json for the banner/`--version`. */
export const PACKAGE_VERSION: string = (() => {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(path.join(here, '..', '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
})();

function printBanner(runtime: ReplRuntime, loaded: string[]): void {
  const rich = runtime.renderer.mode === 'rich';
  const paint = (text: string, code: string): string => (rich ? `\u001b[${code}m${text}\u001b[0m` : text);
  const dim = (text: string): string => paint(text, '2');
  const accent = (text: string): string => paint(text, '36');

  const state = loaded.length > 0
    ? `${loaded.length} file${loaded.length === 1 ? '' : 's'} loaded`
    : 'blank harness';
  const frozen = runtime.repl.isFrozen() ? `  ${paint(' FROZEN ', '41;97')}` : '';

  const title = `  ${paint('DeepClause', '1;36')} ${paint('DML REPL', '1')}  ${dim(`v${runtime.version}`)}${frozen}`;
  const meta = `  ${dim(state)}  ${dim('·')}  ${paint(runtime.model, '35')}  ${dim('·')}  ${dim(`backend ${runtime.backend}`)}`;
  const cwd = `  ${dim(runtime.workspace)}`;
  const help = [
    `  ${accent('goal:')} ${dim('<dml>.')}           run a DML goal, e.g. ${dim('goal: member(X, [1,2,3]).')}`,
    `  ${accent('<plain English>')}        build the harness from a prompt`,
    '',
    `  ${accent('help.')}  ${accent('listing.')}  ${accent('export <file>.')}  ${accent('freeze.')}  ${accent('model.')}  ${accent('halt.')}`,
  ];

  runtime.renderer.writeLine(['', title, meta, cwd, '', ...help, ''].join('\n'));
}

/** Dispatch one classified input. Returns false when the REPL should exit. */
export async function dispatchReplInput(
  runtime: ReplRuntime,
  input: ReplInput,
  options: { first?: boolean; print?: (text: string) => void; exportPath?: string; signal?: AbortSignal } = {},
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
    case 'rollback': {
      const result = await repl.rollback();
      if (result.ok) {
        print(`rolled back harness: version ${result.from} → ${result.to}`);
      } else {
        print(`ERROR: ${result.error ?? 'rollback failed'}`);
      }
      return true;
    }
    case 'model': {
      if (input.model) {
        await updateConfig(runtime.workspace, { backend: { kind: 'pi', model: input.model } });
        print(`default model set to ${input.model} (takes effect on the next start)`);
      } else {
        print(`model: ${runtime.model}`);
        print(`backend: ${runtime.backend}`);
        print("set with 'model <provider/id>.' or 'deepclause login'");
      }
      return true;
    }
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
      await runGoalWithRenderer(repl, input.goal, { first: options.first, renderer, signal: options.signal });
      return true;
    case 'prompt': {
      if (runtime.missingCredential) {
        print(`ERROR: ${runtime.missingCredential}`);
        return true;
      }
      for await (const event of repl.prompt(input.prompt, { signal: options.signal })) {
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
    '  rollback.           undo the last harness change',
    '  model.              show the model; model <provider/id>. sets it',
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
/**
 * Route Ctrl-C to the active turn. While a turn is running the first Ctrl-C
 * aborts it (the session then saves the harness to a temp file); a Ctrl-C while
 * idle exits.
 */
function installSigint(
  runtime: ReplRuntime,
  holder: { turn: AbortController | null },
  rl?: readline.Interface,
): () => void {
  const handler = () => {
    if (holder.turn) {
      holder.turn.abort(new Error('cancelled by user'));
      runtime.renderer.writeErrorLine('(cancelling current turn… press Ctrl-C again to exit)');
    } else {
      process.exit(130);
    }
  };
  process.on('SIGINT', handler);
  rl?.on('SIGINT', handler);
  return () => {
    process.off('SIGINT', handler);
    rl?.off('SIGINT', handler);
  };
}

async function runNonInteractive(runtime: ReplRuntime, options: ReplCliOptions): Promise<number> {
  let exitCode = 0;
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const holder: { turn: AbortController | null } = { turn: null };
  const removeSigint = installSigint(runtime, holder, rl);
  try {
    for await (const line of rl) {
      const input = classifyReplInput(line);
      if (input.kind === 'halt') break;
      const controller = new AbortController();
      holder.turn = controller;
      try {
        const keepGoing = await dispatchReplInput(runtime, input, {
          first: options.first,
          exportPath: options.exportPath,
          signal: controller.signal,
        });
        if (!keepGoing) break;
      } finally {
        holder.turn = null;
      }
    }
  } finally {
    removeSigint();
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
  // A single readline interface serves the REPL prompt, the input handler, and
  // the pager. `rl.question` can be called whenever no other question is
  // pending (the loop is blocked inside a turn), so ask_user / input/2 do not
  // need a second interface (which double-echoed and closed stdin).
  let rlClosed = false;
  rl.on('close', () => {
    rlClosed = true;
  });
  const ask = (query: string): Promise<string | null> => new Promise((resolve) => {
    // Calling question() on a closed interface throws; treat it as EOF.
    if (rlClosed) {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      rl.off('close', onClose);
      resolve(value);
    };
    const onClose = () => finish(null);
    rl.once('close', onClose);
    rl.question(query, (answer) => finish(answer));
  });

  runtime.setOnInput(async (prompt, choices) => {
    const options = choices && choices.length > 0 ? ` (${choices.join('/')})` : '';
    runtime.renderer.writeLine('');
    runtime.renderer.writeLine(`? ${prompt}${options}`);
    const answer = await ask('> ');
    return answer === null ? undefined : answer;
  });

  const holder: { turn: AbortController | null } = { turn: null };
  const removeSigint = installSigint(runtime, holder, rl);

  try {
    while (true) {
      const line = await ask(promptPrefix);
      if (line === null) break;
      const input = classifyReplInput(line);
      if (input.kind === 'halt') break;

      const controller = new AbortController();
      holder.turn = controller;
      try {
        if (input.kind === 'goal') {
          await runInteractiveGoal(runtime.repl, runtime.renderer, input.goal, options, ask, controller.signal);
        } else {
          const keepGoing = await dispatchReplInput(runtime, input, {
            first: options.first,
            exportPath: options.exportPath,
            signal: controller.signal,
          });
          if (!keepGoing) break;
        }
      } finally {
        holder.turn = null;
      }
    }
  } finally {
    removeSigint();
    rl.close();
  }
  return 0;
}

export async function runInteractiveGoal(
  repl: HarnessRepl,
  renderer: ReplRenderer,
  goal: string,
  options: ReplCliOptions,
  ask: (query: string) => Promise<string | null>,
  signal?: AbortSignal,
): Promise<void> {
  const iterator = repl.query(goal, { signal })[Symbol.asyncIterator]();
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
          // SWI-style pager: ';' continues, '.' or Enter stops, a/w/p print all.
          const key = await ask(' ;');
          const trimmed = (key ?? '').trim();
          if (trimmed === '' || trimmed === '.' || trimmed === 'd') {
            renderer.writeLine('.');
            await iterator.return?.(undefined);
            return;
          }
          if (trimmed === 'a' || trimmed === 'w' || trimmed === 'p') {
            pageAll = true;
          }
        }
      } else if (value.type === 'error') {
        renderer.render(value);
      } else if (value.type !== 'finished') {
        // Render output/stream/tool_call/task_activity/usage/reasoning, exactly
        // like the `-g` path (runGoalWithRenderer); otherwise an interactive
        // goal is silent until its first solution.
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
      const controller = new AbortController();
      const removeSigint = installSigint(runtime, { turn: controller });
      try {
        for (const goal of goals) {
          if (controller.signal.aborted) break;
          const code = await runGoalWithRenderer(runtime.repl, goal, {
            first: options.first,
            renderer: runtime.renderer,
            signal: controller.signal,
          });
          if (code !== 0) exitCode = code;
        }
      } finally {
        removeSigint();
      }
      return exitCode;
    }

    if (!process.stdin.isTTY) {
      return await runNonInteractive(runtime, options);
    }
    printBanner(runtime, options.load ?? []);
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
    await runtime.toolset.dispose();
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
    .option('--depth <number>', 'maximum nested frame depth (default 3)', parseInt)
    .option('--max-model-calls <number>', 'maximum model calls per turn (default 100)', parseInt)
    .option('--backend <kind>', 'override the configured backend (env|pi)')
    .option('--no-stream', 'hide streamed model text/reasoning (show only outputs and solutions)')
    .option('--no-events', 'hide task activity, tool calls, usage, and logs')
    .option('--judge <name>', 'default judgment backend (llm|jev)')
    .option('--tools <list>', 'comma-separated capability host tools (default: bash)')
    .option('--no-tools', 'register no capability host tools')
    .option('--sandbox', 'run shell tools in AgentVM')
    .option('--no-ask', 'make ask_user / input/2 fail instead of prompting')
    .option('--answer <text>', 'canned answer for any input request')
    .option('--interactive-input', 'allow input requests to read stdin in non-TTY/--json mode')
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
        depth: options.depth,
        maxModelCalls: options.maxModelCalls,
        backend: options.backend,
        stream: options.stream,
        events: options.events,
        judge: options.judge,
        tools: typeof options.tools === 'string' ? options.tools : undefined,
        noTools: options.tools === false,
        sandbox: options.sandbox,
        noAsk: options.ask === false,
        answer: options.answer,
        interactiveInput: options.interactiveInput,
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
