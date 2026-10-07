/**
 * `deepclause run` — execute a DML file once.
 *
 * This is the same engine as the REPL: it opens a `DMLSession` (the living
 * module), loads the file, runs one entry goal, and renders events through the
 * REPL renderer. The entry is `agent_main/N` (built from the positional args) or
 * an explicit `--goal <dml>`. Natural-language authoring is the REPL's job.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

import { loadConfig, resolveCompactionConfig, type Provider } from './config.js';
import { promptUser } from './readline.js';
import type { DMLEvent } from '../types.js';
import { DMLSession } from '../repl/session.js';
import { ReplRenderer, type RenderMode } from '../repl/render.js';
import { createReplToolset } from '../repl/toolset.js';
import { resolveLlmBackend, type BackendKind } from '../repl/backend.js';
import { resolveReplJudgeSelection } from '../repl/judge.js';
import { recordTokenUsage, type TokenUsageByModel } from '../system/runtime/token-usage.js';
import { buildDmlParams } from '../system/runtime/dml-params.js';

export interface RunOptions {
  configRoot?: string;
  workspace?: string;
  backend?: BackendKind;
  /** Explicit entry goal (e.g. `my_skill("x")`); overrides `agent_main`. */
  goal?: string;
  verbose?: boolean;
  stream?: boolean;
  events?: boolean;
  plain?: boolean;
  json?: boolean;
  color?: boolean;
  sandbox?: boolean;
  trace?: string;
  dryRun?: boolean;
  model?: string;
  provider?: Provider;
  temperature?: number;
  gasLimit?: number;
  signal?: AbortSignal;
  toolAbortSignalRef?: { signal?: AbortSignal };
  params?: Record<string, string>;
  onUserInput?: (prompt: string) => Promise<string>;
  onEvent?: (event: DMLEvent) => void;
}

export interface RunResult {
  output: string[];
  answer?: string;
  error?: string;
  dryRun?: boolean;
  wouldExecute?: string;
  trace?: object;
  events?: DMLEvent[];
  usageByModel?: TokenUsageByModel;
}

const PROVIDER_ENV_KEYS: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

export async function run(
  file: string | undefined,
  args: string[],
  options: RunOptions = {},
): Promise<RunResult> {
  if (!file) {
    throw new Error('A DML file is required: deepclause run <file> [args...]');
  }

  const configRoot = path.resolve(options.configRoot ?? process.cwd());
  const config = await loadConfig(configRoot);

  const absolutePath = await resolveDmlPath(file, configRoot);
  try {
    await fs.access(absolutePath);
  } catch {
    throw new Error(`Failed to read DML file: ${absolutePath}`);
  }

  const workspacePath = options.workspace
    ? path.resolve(configRoot, options.workspace)
    : path.resolve(configRoot, config.workspace || './workspace');
  await fs.mkdir(workspacePath, { recursive: true });

  const backend = await resolveLlmBackend({
    kind: options.backend ?? config.backend?.kind ?? 'pi',
    model: options.model ?? config.backend?.model,
    provider: options.provider,
    agentDir: config.backend?.agentDir,
    modelsPath: config.backend?.modelsPath ?? undefined,
    authPath: config.backend?.authPath ?? undefined,
  });

  const { selection: judgeSelection, warnings: judgeWarnings } = resolveReplJudgeSelection({
    llmBackend: backend.llmBackend,
    model: backend.model,
    provider: backend.provider,
    temperature: options.temperature ?? config.temperatures.run,
    defaultJudge: config.judgment.default,
    jev: {
      enabled: config.judgment.jev.enabled,
      model: config.judgment.jev.model,
      apiKeyEnv: config.judgment.jev.apiKeyEnv,
    },
  });
  for (const warning of judgeWarnings) {
    process.stderr.write(`[deepclause] ${warning}\n`);
  }

  const providerConfig = config.providers?.[backend.provider as keyof typeof config.providers];
  const envKey = PROVIDER_ENV_KEYS[backend.provider];
  if (envKey && providerConfig?.apiKey) {
    process.env[envKey] = providerConfig.apiKey;
  }

  const render: RenderMode = options.json ? 'json' : (options.plain || !process.stdout.isTTY) ? 'plain' : 'rich';
  const renderer = new ReplRenderer({
    mode: render,
    color: options.color !== false && render === 'rich',
    verbose: options.verbose ?? false,
    stream: options.stream !== false,
    events: options.events !== false,
  });

  const toolset = await createReplToolset({
    workspacePath,
    sandbox: options.sandbox,
    network: config.agentvm?.network ?? false,
    hostConfig: config.shell,
    signal: options.signal,
    onEvent: (event) => {
      // The runner already emits tool_call events; only render the extras
      // (shell stdout/stderr/log lines) so nothing is duplicated.
      if (event.type !== 'tool_call') renderer.render(event);
    },
  });

  const session = await DMLSession.open({
    workspacePath,
    gasLimit: options.gasLimit,
    params: buildDmlParams(args, options.params, null),
    tools: toolset.tools,
    runnerOptions: {
      model: backend.model,
      provider: backend.provider as Provider,
      temperature: options.temperature ?? config.temperatures.run,
      maxTokens: 65536,
      // Always stream internally; `--no-stream` only hides the streamed text at
      // the renderer. (With runner streaming off, model narration is re-emitted
      // as `output` events, which `--no-stream` could not suppress.)
      streaming: true,
      trace: !!options.trace,
      debug: options.verbose ?? false,
      baseUrl: providerConfig?.baseUrl,
      llmBackend: backend.llmBackend,
      judgeSelection,
      compaction: resolveCompactionConfig(config, configRoot),
    },
    onInput: options.onUserInput ?? promptUser,
  });

  const usageByModel: TokenUsageByModel = {};
  const result: RunResult = { output: [], events: [] };

  try {
    const loaded = await session.load(absolutePath);
    if (loaded.error) {
      throw new Error(loaded.error);
    }

    const goal = options.goal ?? resolveEntryGoal(session, args);

    if (options.dryRun) {
      return {
        output: [],
        dryRun: true,
        wouldExecute: [
          'DRY RUN — would execute:',
          `  file:      ${absolutePath}`,
          `  backend:   ${backend.kind}`,
          `  model:     ${backend.modelId}`,
          `  workspace: ${workspacePath}`,
          `  goal:      ${goal}`,
        ].join('\n'),
      };
    }

    for await (const event of session.query(goal, { signal: options.signal })) {
      (result.events ??= []).push(event);
      options.onEvent?.(event);

      switch (event.type) {
        case 'output':
          if (event.content) result.output.push(event.content);
          break;
        case 'answer':
          result.answer = event.content;
          break;
        case 'error':
          result.error = event.content;
          if (event.trace) result.trace = event.trace;
          break;
        case 'finished':
          if (event.trace) result.trace = event.trace;
          break;
        case 'usage':
          if (event.usage) recordTokenUsage(usageByModel, backend.model, event.usage);
          break;
        default:
          break;
      }

      renderer.render(event);
    }

    if (Object.keys(usageByModel).length > 0) {
      result.usageByModel = usageByModel;
    }
    return result;
  } finally {
    await session.dispose();
    await toolset.dispose();
  }
}

/** The entry goal: `--goal`, or `agent_main/N` built from the positional args. */
function resolveEntryGoal(session: DMLSession, args: string[]): string {
  const arities = session.predicateArities('agent_main');
  if (arities.length === 0) {
    throw new Error(
      'the DML file defines no agent_main/0..2; pass --goal "<dml>" to run a specific goal',
    );
  }
  if (!arities.includes(args.length)) {
    throw new Error(
      `agent_main expects ${arities.join('/')} argument(s) but received ${args.length}; `
      + 'pass --goal "<dml>" for a custom entry',
    );
  }
  if (args.length === 0) {
    return 'agent_main';
  }
  return `agent_main(${args.map(toPrologArg).join(', ')})`;
}

/** Render a CLI positional arg as a Prolog term (number / boolean / string). */
function toPrologArg(value: string): string {
  const trimmed = value.trim();
  if (trimmed !== '' && !Number.isNaN(Number(trimmed))) {
    return trimmed;
  }
  if (trimmed === 'true' || trimmed === 'false') {
    return trimmed;
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

async function resolveDmlPath(file: string, configRoot: string): Promise<string> {
  const candidate = path.resolve(configRoot, file);
  if (await fileExists(candidate)) {
    return candidate;
  }
  if (!candidate.endsWith('.dml') && await fileExists(`${candidate}.dml`)) {
    return `${candidate}.dml`;
  }
  return candidate;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
