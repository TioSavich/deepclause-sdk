/**
 * One-shot DML execution for `deepclause run`.
 *
 * Uses the shared pi/env backend (`llmBackend` when pi) and renders every
 * runtime event through the REPL's `ReplRenderer`, so `run` and `repl` present
 * events identically.
 */

import * as path from 'path';

import { createDeepClause } from '../../sdk.js';
import type { Config } from '../../cli/config.js';
import { resolveCompactionConfig } from '../../cli/config.js';
import type { DMLEvent, LLMBackend, MemoryMessage } from '../../types.js';
import { ReplRenderer, type RenderMode } from '../../repl/render.js';
import { recordTokenUsage, type TokenUsageByModel } from './token-usage.js';
import { registerLocalRuntimeTools } from './runtime-tools.js';
import { createShellManager } from './shell-manager.js';

export interface ExecuteDmlOptions {
  dmlCode: string;
  config: Config;
  workspaceRoot?: string;
  workspacePath: string;
  /** Env-backend model/provider; ignored when `llmBackend` is set (pi). */
  model: string;
  provider: string;
  temperature?: number;
  maxTokens?: number;
  apiKey?: string;
  baseUrl?: string;
  /** Injected backend (pi). */
  llmBackend?: LLMBackend;
  args?: unknown[];
  params?: Record<string, unknown>;
  gasLimit?: number;
  stream?: boolean;
  trace?: boolean;
  verbose?: boolean;
  /** Event rendering: `rich` | `plain` | `json`. */
  render?: RenderMode;
  sandbox?: boolean;
  signal?: AbortSignal;
  toolAbortSignalRef?: { signal?: AbortSignal };
  onUserInput?: (prompt: string) => Promise<string>;
  initialMessages?: MemoryMessage[];
  onEvent?: (event: DMLEvent) => void;
}

export interface ExecuteDmlResult {
  output: string[];
  answer?: string;
  error?: string;
  trace?: object;
  events: DMLEvent[];
  usageByModel?: TokenUsageByModel;
}

export async function executeDml(options: ExecuteDmlOptions): Promise<ExecuteDmlResult> {
  const resolvedWorkspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());

  const shell = createShellManager({
    workspacePath: options.workspacePath,
    sandbox: options.sandbox,
    network: options.config.agentvm?.network ?? false,
    hostConfig: options.config.shell,
  });

  const sdk = await createDeepClause({
    model: options.model,
    provider: options.provider as 'openai' | 'anthropic' | 'google' | 'openrouter',
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    temperature: options.temperature,
    trace: !!options.trace,
    streaming: options.stream,
    debug: options.verbose,
    maxTokens: options.maxTokens ?? 65536,
    llmBackend: options.llmBackend,
    compaction: resolveCompactionConfig(options.config, resolvedWorkspaceRoot),
  });

  const renderer = new ReplRenderer({
    mode: options.render ?? 'plain',
    color: false,
    verbose: options.verbose ?? false,
  });

  const result: ExecuteDmlResult = { output: [], events: [] };
  const usageByModel: TokenUsageByModel = {};
  let finished = false;

  const handleEvent = (event: DMLEvent): void => {
    result.events.push(event);
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
        finished = true;
        break;
      case 'finished':
        if (event.trace) result.trace = event.trace;
        finished = true;
        break;
      case 'usage':
        if (event.usage) recordTokenUsage(usageByModel, options.model, event.usage);
        break;
      default:
        break;
    }

    renderer.render(event);
  };

  try {
    registerLocalRuntimeTools(sdk, {
      workspaceRoot: options.workspaceRoot,
      workspacePath: options.workspacePath,
      shell,
      signal: options.signal,
      toolAbortSignalRef: options.toolAbortSignalRef,
      onEvent: handleEvent,
    });

    for await (const event of sdk.runDML(options.dmlCode, {
      args: options.args,
      params: options.params,
      workspacePath: options.workspacePath,
      gasLimit: options.gasLimit,
      signal: options.signal,
      onUserInput: options.onUserInput,
      initialMessages: options.initialMessages,
    })) {
      if (finished) break;
      handleEvent(event);
    }

    if (Object.keys(usageByModel).length > 0) {
      result.usageByModel = usageByModel;
    }
    return result;
  } finally {
    await sdk.dispose();
    await shell.dispose();
  }
}
