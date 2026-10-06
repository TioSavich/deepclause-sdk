/**
 * Public REPL facade.
 *
 * `createHarnessRepl` opens a persistent `DMLSession` and exposes the surface
 * used by the CLI (and, later, by pi). M1 implements goal mode, loading, and
 * reset; prompt mode / freeze / export are filled in by later milestones.
 */

import type {
  DMLEvent,
  LLMBackend,
  MemoryMessage,
  ToolDefinition,
  ToolPolicy,
} from '../types.js';
import type { FrameKind } from '../types.js';
import { DMLSession, type DMLQueryOptions } from './session.js';
import type { HarnessExportOptions, HarnessExportResult } from './export.js';

export type RunOpts = DMLQueryOptions;

/** Goal-mode events are DMLEvents today; kept as a named alias for the API. */
export type DMLQueryEvent = DMLEvent;
export type ReplEvent = DMLEvent;

export interface HarnessReplOptions {
  sessionId?: string;
  workspacePath?: string;
  params?: Record<string, unknown>;
  gasLimit?: number;
  model: string;
  provider: 'openai' | 'anthropic' | 'google' | 'openrouter';
  temperature?: number;
  maxTokens?: number;
  llmBackend?: LLMBackend;
  tools?: Map<string, ToolDefinition>;
  toolPolicy?: ToolPolicy | null;
  onInputRequired?: (prompt: string) => Promise<string>;
  initialHarnessMemory?: MemoryMessage[];
}

export interface HarnessRepl {
  /** Goal mode: run a goal, enumerating solutions/events. */
  query(goal: string, opts?: RunOpts): AsyncGenerator<DMLQueryEvent>;
  /** Prompt mode (M3): NL -> task -> DML -> commit -> run. */
  prompt(request: string, opts?: RunOpts): AsyncGenerator<ReplEvent>;
  /** Load a DML file into the living module. */
  load(file: string): Promise<{ error?: string }>;
  /** Read-only listing of the living module. */
  list(filter?: string): Promise<string>;
  /** Read-only lock (M2). */
  freeze(): Promise<void>;
  /** Irreversible freeze: `unfreeze.` is refused (--locked). */
  lock(): Promise<void>;
  unfreeze(): Promise<void>;
  /** Write the harness to a self-contained .dml file (M2). */
  export(file?: string, options?: HarnessExportOptions): Promise<HarnessExportResult>;
  isFrozen(): boolean;
  reset(): Promise<void>;
  dispose(): Promise<void>;
  /** The underlying session (used by the CLI for session id / frame kind). */
  readonly session: DMLSession;
}

class HarnessReplImpl implements HarnessRepl {
  readonly session: DMLSession;

  constructor(session: DMLSession) {
    this.session = session;
  }

  query(goal: string, opts?: RunOpts): AsyncGenerator<DMLQueryEvent> {
    return this.session.query(goal, opts);
  }

  // eslint-disable-next-line require-yield
  async *prompt(): AsyncGenerator<ReplEvent> {
    throw new Error('Prompt mode is not available yet (M3)');
  }

  load(file: string): Promise<{ error?: string }> {
    return this.session.load(file);
  }

  list(filter = 'all'): Promise<string> {
    return this.session.listing(filter);
  }

  freeze(): Promise<void> {
    return this.session.freeze();
  }

  lock(): Promise<void> {
    return this.session.lock();
  }

  unfreeze(): Promise<void> {
    return this.session.unfreeze();
  }

  export(file?: string, options?: HarnessExportOptions): Promise<HarnessExportResult> {
    return this.session.export(file, options);
  }

  isFrozen(): boolean {
    return this.session.isFrozen();
  }

  reset(): Promise<void> {
    return this.session.reset();
  }

  dispose(): Promise<void> {
    return this.session.dispose();
  }
}

export async function createHarnessRepl(options: HarnessReplOptions): Promise<HarnessRepl> {
  const session = await DMLSession.open({
    sessionId: options.sessionId,
    workspacePath: options.workspacePath,
    params: options.params,
    gasLimit: options.gasLimit,
    initialHarnessMemory: options.initialHarnessMemory,
    tools: options.tools,
    toolPolicy: options.toolPolicy,
    onInputRequired: options.onInputRequired,
    runnerOptions: {
      model: options.model,
      provider: options.provider,
      temperature: options.temperature ?? 0.7,
      maxTokens: options.maxTokens ?? 65536,
      llmBackend: options.llmBackend,
    },
  });
  return new HarnessReplImpl(session);
}

export type { DMLSession, DMLQueryOptions, FrameKind };
