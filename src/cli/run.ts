/**
 * `deepclause run` — execute a DML file once.
 *
 * Uses the shared pi/env backend (same as the REPL) and renders events through
 * the REPL renderer. Natural-language authoring is the REPL's job, so there is
 * no compiler path here.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

import { loadConfig, type Provider } from './config.js';
import { promptUser } from './readline.js';
import type { DMLEvent } from '../types.js';
import { executeDml } from '../system/runtime/dml-executor.js';
import { buildDmlParams } from '../system/runtime/dml-params.js';
import { resolveLlmBackend, type BackendKind } from '../repl/backend.js';
import type { RenderMode } from '../repl/render.js';

export interface RunOptions {
  configRoot?: string;
  workspace?: string;
  backend?: BackendKind;
  verbose?: boolean;
  stream?: boolean;
  plain?: boolean;
  json?: boolean;
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
  usageByModel?: Record<string, { calls: number; inputTokens: number; outputTokens: number; totalTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number }>;
}

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
  let dmlCode: string;
  try {
    dmlCode = await fs.readFile(absolutePath, 'utf-8');
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

  const params = buildDmlParams(args, options.params, null);

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
        `  params:    ${JSON.stringify(params)}`,
      ].join('\n'),
    };
  }

  const providerConfig = config.providers?.[backend.provider as keyof typeof config.providers];
  const render: RenderMode = options.json ? 'json' : (options.plain || !process.stdout.isTTY) ? 'plain' : 'rich';

  const result = await executeDml({
    dmlCode,
    config,
    workspaceRoot: configRoot,
    workspacePath,
    model: backend.model,
    provider: backend.provider,
    llmBackend: backend.llmBackend,
    temperature: options.temperature ?? config.temperatures.run,
    apiKey: providerConfig?.apiKey,
    baseUrl: providerConfig?.baseUrl,
    args,
    params,
    gasLimit: options.gasLimit,
    stream: options.stream,
    trace: !!options.trace,
    verbose: options.verbose,
    render,
    sandbox: options.sandbox,
    signal: options.signal,
    toolAbortSignalRef: options.toolAbortSignalRef,
    onEvent: options.onEvent,
    onUserInput: options.onUserInput ?? promptUser,
  });

  return {
    output: result.output,
    answer: result.answer,
    error: result.error,
    trace: result.trace,
    events: result.events,
    usageByModel: result.usageByModel,
  };
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
